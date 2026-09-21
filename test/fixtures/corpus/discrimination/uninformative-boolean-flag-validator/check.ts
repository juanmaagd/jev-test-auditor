export function checkConfig(config: { host: string; port: number }): boolean {
  return config.host.length > 0 && config.port > 0;
}
