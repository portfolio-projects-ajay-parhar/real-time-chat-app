import { z } from "zod";

const envSchema = z.object({
  WS_PORT: z.coerce.number().int().positive().default(4001),
  ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(1),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error("❌ Invalid ws environment:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration for @chat/ws");
  }
  return parsed.data;
}
