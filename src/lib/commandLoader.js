import { writeFile, mkdir, rm, symlink } from "fs/promises";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
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

function patchSource(content, category) {
  let src = content;

  src = src.replace(/from\s+['"]baileys['"]/g, `from '${BAILEYS}'`);

  const HANDLER = join(__dir, "handler.js");
  src = src.replace(/from\s+['"]\.\.\/\.\.\/src\/lib\/handler\.js['"]/g, `from '${HANDLER}'`);

  const WORKER_API = join(__dir, "workerApi.js");
  src = src.replace(/from\s+['"]\.\.\/\.\.\/src\/lib\/workerApi\.js['"]/g, `from '${WORKER_API}'`);

  src = src.replace(
    /from\s+['"]\.\/([\w.-]+\.js)['"]/g,
    (_, relFile) => `from '${join(TMP, category + "_" + relFile)}'`
  );

  return src;
}

async function importBundle(bundle, tag) {
  if (!bundle) return;

  const fileMap = [];
  for (const [relPath, content] of Object.entries(bundle)) {
    const parts = relPath.split("/");
    const category = parts.length > 1 ? parts[0].toLowerCase() : "general";
    const fileName = parts[parts.length - 1];
    const flatName = parts.length > 1 ? `${category}_${fileName}` : fileName;
    const filePath = join(TMP, flatName);
    const patched = patchSource(content, category);

    await writeFile(filePath, patched, "utf8");
    fileMap.push({ relPath, category, filePath });
  }

  for (const { relPath, category, filePath } of fileMap) {
    try {
      const mod = await import(`${filePath}?v=${Date.now()}`);
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
      logger.error({ relPath, err: err.message }, "command file failed to load");
    }
  }
}

export async function loadCommands() {
  commands.clear();
  aliases.clear();
  categories.clear();
  messageListeners.length = 0;

  const bundle = await workerApi.getCommandBundle();

  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, "package.json"), '{"type":"module"}', "utf8");
  await symlink(NODE_MODULES, join(TMP, "node_modules"), "dir").catch(() => {});

  await importBundle(bundle.prodBundle, "prod");

  if (bundle.fileMode === "beta" && bundle.betaBundle) {
    await importBundle(bundle.betaBundle, "beta");
  }

  logger.info(
    { commands: commands.size, categories: categories.size, fileMode: bundle.fileMode },
    "commands loaded"
  );
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
