export interface RemoteEnvironment {
  host: string;
  file: string;
  reload?: string;
}

export interface ProjectConfig {
  file: string;
  example: string;
  localName: string;
  sort: boolean;
  undeclared: "warn" | "error";
}

export interface LitenvConfig {
  path: string;
  root: string;
  project: ProjectConfig;
  environments: Record<string, RemoteEnvironment>;
}
