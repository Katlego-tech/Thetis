import type { Metadata } from "next";
import { RunPage, type RunResult } from "@/components/judge/run-page";
import { JudgeReadError, readJudgeView } from "@/data/judge/read";
import "./run.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "One run on devnet",
  description:
    "Every transaction of one Thetis rehearsal run on devnet, as the program confirmed it.",
};

/** The public run page: no sign-in, read with the anon key through public.judge_run(). */
export default async function Run() {
  let result: RunResult;
  try {
    result = { ok: true, view: await readJudgeView() };
  } catch (error) {
    if (!(error instanceof JudgeReadError)) throw error;
    result = { ok: false, kind: error.kind };
  }
  return <RunPage result={result} />;
}
