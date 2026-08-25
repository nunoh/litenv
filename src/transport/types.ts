export interface EnvTransport {
  read(): Promise<string>;
  write(content: string): Promise<void>;
}
