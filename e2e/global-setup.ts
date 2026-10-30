import { seed } from "../test/support/seed.ts";

// Fresh fixtures for every run: the e2e flows write to the seeded tables.
export default async function globalSetup() {
  await seed();
}
