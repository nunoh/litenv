import { EnvDocument } from "./document.js";

export interface EnvDiff {
  onlyLocal: Array<[string, string]>;
  onlyRemote: Array<[string, string]>;
  different: Array<[string, string, string]>;
  same: Array<[string, string]>;
}

export function diffDocuments(local: EnvDocument, remote: EnvDocument): EnvDiff {
  const localValues = new Map(local.entries());
  const remoteValues = new Map(remote.entries());
  const onlyLocal: Array<[string, string]> = [];
  const onlyRemote: Array<[string, string]> = [];
  const different: Array<[string, string, string]> = [];
  const same: Array<[string, string]> = [];

  for (const [key, localValue] of localValues) {
    if (!remoteValues.has(key)) onlyLocal.push([key, localValue]);
    else {
      const remoteValue = remoteValues.get(key) ?? "";
      if (localValue === remoteValue) same.push([key, localValue]);
      else different.push([key, localValue, remoteValue]);
    }
  }
  for (const [key, remoteValue] of remoteValues) {
    if (!localValues.has(key)) onlyRemote.push([key, remoteValue]);
  }

  const byKey = <T extends [string, ...string[]]>(left: T, right: T) => left[0].localeCompare(right[0]);
  onlyLocal.sort(byKey);
  onlyRemote.sort(byKey);
  different.sort(byKey);
  same.sort(byKey);
  return { onlyLocal, onlyRemote, different, same };
}
