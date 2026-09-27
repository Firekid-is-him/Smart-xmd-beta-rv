import { writeFile, mkdir, rm, symlink } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import pino from "pino";
import { workerApi } from "./workerApi.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

const TMP = join(tmpdir(), "firekid_cmds");
const __dir = dirname(fileURLToPath(import.meta.url));
const NODE_MODULES = join(__dir, "../../node_modules");
const BAILEYS = join(NODE_MODULES, "baileys", "lib", "index.js");

const commands = new Map();
const aliases = new Map();
const categories = new Map();
const messageListeners = [];

// Every reload previously re-imported EVERY command file as a brand-new
// module instance (the `?v=${Date.now()}` cache-buster on every single
// file), because ESM dynamic import() results are permanently retained by
// Node — there's no equivalent of delete require.cache[...] for ESM, so
// every one of those old instances just leaks for the life of the
// process. There's no way to fully eliminate this (Node genuinely has no
// module-unload API), but it doesn't have to apply to files that didn't
// change: this map remembers each flattened file's last-imported content
// hash, and importBundle below only cache-busts (creates a new instance
// of) files whose hash actually changed since the previous load. An
// unchanged file gets imported with a stable, hash-based query string, so
// Node's own module cache (keyed by the resolved URL) returns the
// already-loaded instance instead of minting a new one — shrinking the
// leak from "every file, every reload" to "only what was actually edited,
// once per edit".
const lastImportedHash = new Map();

function hashContent(content) {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

function patchSource(content, category) {
  let src = content;

  src = src.replace(/from\s+['"]baileys['"]/g, `from '${BAILEYS}'`);

  const HANDLER = join(__dir, "handler.js");
  src = src.replace(/from\s+['"]\.\.\/\.\.\/src\/lib\/handler\.js['"]/g, `from '${HANDLER}'`);

  const WORKER_API = join(__dir, "workerApi.js");
  src = src.replace(/from\s+['"]\.\.\/\.\.\/src\/lib\/workerApi\.js['"]/g, `from '${WORKER_API}'`);

  // Lets a command (system.js's .menu/.help) introspect the loaded command
  // set — getCategories/getAllCommands/getCommand — via the same live
  // module instance this file itself populates. Not circular in the
  // ES-module-cycle sense: command files are dynamically import()ed here
  // only after this module has already finished executing and its
  // module-level Maps are populated, so the imported getters read live,
  // already-populated state, not a half-initialized module.
  const COMMAND_LOADER = join(__dir, "commandLoader.js");
  src = src.replace(/from\s+['"]\.\.\/\.\.\/src\/lib\/commandLoader\.js['"]/g, `from '${COMMAND_LOADER}'`);

  src = src.replace(
    /from\s+['"]\.\/([\w.-]+\.js)['"]/g,
    (_, relFile) => `from '${join(TMP, category + "_" + relFile)}'`
  );

  return src;
}

async function importBundle(bundle, tag) {
  const failures = [];
  if (!bundle) return failures;

  const fileMap = [];
  for (const [relPath, content] of Object.entries(bundle)) {
    const parts = relPath.split("/");
    const category = parts.length > 1 ? parts[0].toLowerCase() : "general";
    const fileName = parts[parts.length - 1];
    const flatName = parts.length > 1 ? `${category}_${fileName}` : fileName;
    const filePath = join(TMP, flatName);
    const patched = patchSource(content, category);

    await writeFile(filePath, patched, "utf8");
    // Hashed on the patched content (what's actually written to disk and
    // imported), not the raw bundle content — patchSource's output is
    // what determines whether the importable module actually changed.
    fileMap.push({ relPath, category, filePath, hash: hashContent(patched) });
  }

  for (const { relPath, category, filePath, hash } of fileMap) {
    try {
      const previousHash = lastImportedHash.get(filePath);
      // Same content as last time this file was imported: reuse the
      // stable hash as the query string, so Node's module cache (keyed by
      // resolved URL, query string included) returns the existing module
      // instance instead of creating a new one. Only a genuine content
      // change gets a query string that differs from last time, which is
      // the only case where a new instance — and a small permanent leak —
      // is actually unavoidable.
      const mod = await import(`${filePath}?v=${hash}`);
      if (previousHash && previousHash !== hash) {
        logger.info({ relPath }, "command file changed, reimported");
      }
      lastImportedHash.set(filePath, hash);

      const exported = mod.default;
      if (!exported) continue;

      if (typeof exported.onMessage === "function") {
        messageListeners.push(exported.onMessage);
        continue;
      }

      const list = Array.isArray(exported) ? exported : [exported];

      for (const cmd of list) {
        if (!cmd?.command || !cmd?.handler) continue;

        const names = Array.isArray(cmd.command) ? cmd.command : [cmd.command];
        const main = names[0].toLowerCase();
        const existed = commands.has(main);

        cmd.category = category;
        commands.set(main, cmd);

        if (existed) {
          for (const [alias, target] of aliases) {
            if (target === main) aliases.delete(alias);
          }
          if (tag === "beta") {
            logger.info({ command: main }, "beta overrides prod");
          }
        } else {
          if (!categories.has(category)) categories.set(category, []);
          categories.get(category).push(main);
        }

        const allAliases = [...names, ...(cmd.aliases || [])];
        for (const alias of allAliases) aliases.set(alias.toLowerCase(), main);
      }
    } catch (err) {
      // Previously only logged server-side (pino), so a typo in a
      // just-added command file would silently drop that file's commands
      // with no feedback anywhere the person could actually see — the
      // whole point of not needing to restart-and-check-logs for .reload
      // is defeated if failures still only show up in server logs.
      logger.error({ relPath, err: err.message }, "command file failed to load");
      failures.push({ file: relPath, error: err.message });
    }
  }

  return failures;
}

export async function loadCommands() {
  // Snapshot before clearing, so a caller (specifically .reload) can diff
  // against what's loaded afterward and report what's actually new,
  // rather than just a total count that doesn't say whether anything
  // changed.
  const previousNames = new Set(commands.keys());

  commands.clear();
  aliases.clear();
  categories.clear();
  messageListeners.length = 0;

  const bundle = await workerApi.getCommandBundle();

  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "package.json"), '{"type":"module"}', "utf8");
  await symlink(NODE_MODULES, join(TMP, "node_modules"), "dir").catch(() => {});

  // Three-way, matching sessions.file_mode / getCommandBundle's own
  // three-way split on the worker+pairing-server side:
  // - "prod": bundle.prodBundle is the only thing populated, load it
  // - "beta": bundle.prodBundle is null (pairing-server's
  //   getCommandBundle deliberately never reads prod dir in this mode),
  //   so prod commands genuinely don't exist in this process at all —
  //   not just hidden from the menu
  // - "both": both populated, prod loads first, beta loads second and
  //   overrides same-named commands (importBundle's existing override
  //   logic, unchanged) — this is what "beta" used to mean before the
  //   three-way split
  const failures = [];
  if (bundle.prodBundle) {
    failures.push(...(await importBundle(bundle.prodBundle, "prod")));
  }

  if (bundle.betaBundle) {
    failures.push(...(await importBundle(bundle.betaBundle, "beta")));
  }

  logger.info(
    { commands: commands.size, categories: categories.size, fileMode: bundle.fileMode },
    "commands loaded"
  );

  const newNames = [...commands.keys()].filter((name) => !previousNames.has(name));

  return {
    totalCommands: commands.size,
    totalCategories: categories.size,
    fileMode: bundle.fileMode,
    newCommands: newNames,
    failures,
  };
}

export function getCommand(name) {
  const canonical = aliases.get(name.toLowerCase());
  return canonical ? commands.get(canonical) : null;
}

export function getMessageListeners() {
  return messageListeners;
}

export function getCategories() {
  return categories;
}

export function getAllCommands() {
  return [...commands.values()];
}
