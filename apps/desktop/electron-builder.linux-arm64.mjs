import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

export default async ({ projectDir }) => {
  const source = await readFile(path.join(projectDir, "electron-builder.yml"), "utf8");
  const config = parse(source);

  config.linux.target = config.linux.target.map((target) => ({
    ...target,
    arch: ["arm64"],
  }));

  return config;
};
