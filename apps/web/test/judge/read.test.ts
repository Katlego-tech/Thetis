import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadedView } from "./fixture";

const supabase = vi.hoisted(() => ({
  created: [] as { url: string; key: string; options: unknown }[],
  rpc: [] as string[],
  signal: null as AbortSignal | null,
  result: null as null | (() => Promise<{ data: unknown; error: { message: string } | null }>),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, options: unknown) => {
    supabase.created.push({ url, key, options });
    return {
      rpc: (name: string) => {
        supabase.rpc.push(name);
        return {
          abortSignal: (signal: AbortSignal) => {
            supabase.signal = signal;
            if (!supabase.result) throw new Error("result was not set up");
            return supabase.result();
          },
        };
      },
    };
  },
}));

const { JudgeReadError, parseJudgeView, readJudgeView } = await import("@/data/judge/read");

beforeEach(() => {
  supabase.created = [];
  supabase.rpc = [];
  supabase.signal = null;
  supabase.result = null;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
});
afterEach(() => vi.unstubAllEnvs());

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JudgeReadError) return error.kind;
    throw error;
  }
  return "none";
}

test("reads judge_run with the anon key, no session and a timeout signal", async () => {
  const view = loadedView();
  supabase.result = async () => ({ data: JSON.parse(JSON.stringify(view)), error: null });
  expect(await readJudgeView()).toEqual(view);
  expect(supabase.created).toEqual([
    {
      url: "http://127.0.0.1:54321",
      key: "synthetic-anon-key",
      options: { auth: { persistSession: false, autoRefreshToken: false } },
    },
  ]);
  expect(supabase.rpc).toEqual(["judge_run"]);
  expect(supabase.signal).toBeInstanceOf(AbortSignal);

  supabase.result = async () => ({ data: { configured: false }, error: null });
  expect(await readJudgeView()).toEqual({ configured: false });
});

test("a missing URL or key is config, an error or rejection is read, a bad body is shape", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
  expect(await kindOf(readJudgeView())).toBe("config");
  expect(supabase.created).toHaveLength(0);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  expect(await kindOf(readJudgeView())).toBe("config");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");

  supabase.result = async () => ({ data: null, error: { message: "permission denied" } });
  expect(await kindOf(readJudgeView())).toBe("read");
  supabase.result = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
  expect(await kindOf(readJudgeView())).toBe("read");
  supabase.result = async () => ({ data: { configured: true }, error: null });
  expect(await kindOf(readJudgeView())).toBe("shape");
});

const first = (items: unknown): Record<string, unknown> => {
  const item = (items as Record<string, unknown>[])[0];
  if (!item) throw new Error("fixture has no first item");
  return item;
};

test("the parse checks every field's type and the exact keys", () => {
  const shape = (mutate: (v: Record<string, unknown>) => void) => {
    const v = JSON.parse(JSON.stringify(loadedView()));
    mutate(v);
    try {
      parseJudgeView(v);
    } catch (error) {
      return error instanceof JudgeReadError ? error.kind : "other";
    }
    return "ok";
  };
  expect(shape(() => {})).toBe("ok");
  expect(
    shape((v) => {
      v.extra = 1;
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      delete v.refusals;
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      v.network = "mainnet";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      v.expectedTransactions = "9";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      (v.checkpoint as Record<string, unknown>).status = "paused";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      v.checkpoint = null;
    }),
  ).toBe("ok");
  expect(
    shape((v) => {
      first(v.transactions).commitment = "processed";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      first(v.transactions).events = null;
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      first(v.transactions).slot = -1;
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      first(v.refusals).beat = "other";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      first(v.organisations).synthetic = "yes";
    }),
  ).toBe("shape");
  expect(
    shape((v) => {
      first(v.organisations).slug = "khunou";
    }),
  ).toBe("shape");
  expect(() => parseJudgeView({ configured: false, extra: true })).toThrow(JudgeReadError);
  expect(() => parseJudgeView(null)).toThrow(JudgeReadError);
});
