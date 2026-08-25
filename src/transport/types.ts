export interface WriteOptions {
  expectedContent?: string;
}

export interface EnvTransport {
  read(): Promise<string>;
  write(content: string, options?: WriteOptions): Promise<void>;
}
