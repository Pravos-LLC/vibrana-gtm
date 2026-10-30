export type DemoStatus = {
  API_URL: string;
  DB_URL: string;
  PUBLISHABLE_KEY?: string;
  SECRET_KEY?: string;
  ANON_KEY?: string;
  SERVICE_ROLE_KEY?: string;
};
export function demoEnvironment(status: DemoStatus, inherited?: Record<string, string | undefined>): Record<string, string | undefined>;
