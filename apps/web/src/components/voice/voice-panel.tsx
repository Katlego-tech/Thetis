"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type JSX, useEffect, useId, useState } from "react";
import type { RailSection } from "@/components/shell/rail-nav";
import { resolveNavigate, targetsFrom, VOICE_COPY, type VoiceScreen } from "@/lib/voice";
import { useVoice, type VoiceState } from "./voice-provider";

// voice.md §5.1: Talk, its status line, and the typed fallback under it. The fallback is rendered
// and enabled in every voice state; no Talk state disables, hides or covers it.

const SCREEN_ORDER: VoiceScreen[] = ["queue", "exceptions", "lot", "release", "account"];

function talkCopy(state: VoiceState) {
  if (state.phase === "connecting") return VOICE_COPY.talk.connecting;
  if (state.phase === "live") return VOICE_COPY.talk.live;
  if (state.phase === "unavailable") return VOICE_COPY.talk.unavailable;
  return VOICE_COPY.talk.idle;
}

function statusLine(state: VoiceState): string {
  switch (state.phase) {
    case "idle":
      return VOICE_COPY.status.idle;
    case "connecting":
      return state.attempt === 1 ? VOICE_COPY.status.connecting : VOICE_COPY.status.refetching;
    case "live":
      return (
        state.notice ?? (state.speaking ? VOICE_COPY.status.speaking : VOICE_COPY.status.listening)
      );
    case "unavailable":
      return VOICE_COPY.status.unavailable;
  }
}

export function VoicePanel(props: {
  organisationId: string;
  sections: RailSection[];
}): JSX.Element {
  const { organisationId, sections } = props;
  const { state, talk, end, setTargets } = useVoice();
  const router = useRouter();
  const id = useId();
  const [screen, setScreen] = useState<VoiceScreen>("lot");
  const [lotId, setLotId] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setTargets(targetsFrom(organisationId, sections));
  }, [organisationId, sections, setTargets]);

  const copy = talkCopy(state);
  const connecting = state.phase === "connecting";
  const live = state.phase === "live";
  const down = state.phase === "unavailable";
  const needsId = screen === "lot" || screen === "release";

  function open(event: FormEvent) {
    event.preventDefault();
    const { result, href } = resolveNavigate(
      { screen, id: lotId },
      targetsFrom(organisationId, sections),
    );
    if (result.ok && href) {
      setRefusal(null);
      router.push(href);
    } else if (!result.ok) {
      setRefusal(result.message);
    }
  }

  return (
    <section className="rail-voice" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="rail-heading rail-voice-heading">
        {VOICE_COPY.heading}
      </h2>
      <div className="rail-voice-talk">
        <button
          type="button"
          className={`voice-button${live ? " is-live" : ""}${connecting ? " is-waiting" : ""}`}
          aria-label={copy.name}
          aria-disabled={connecting ? true : undefined}
          onClick={() => (live ? end() : talk())}
        >
          {copy.label}
        </button>
        <p role="status" className={`voice-status${down ? " is-down" : ""}`}>
          {statusLine(state)}
          {state.phase === "unavailable" && state.cause === "microphone" && (
            <small>{VOICE_COPY.status.microphone}</small>
          )}
        </p>
      </div>
      <form className="rail-voice-fallback" onSubmit={open}>
        <label className="voice-label" htmlFor={`${id}-screen`}>
          {VOICE_COPY.fallback.screenLabel}
        </label>
        <select
          id={`${id}-screen`}
          className="voice-control"
          value={screen}
          onChange={(event) => {
            setScreen(event.target.value as VoiceScreen);
            setRefusal(null);
          }}
        >
          {SCREEN_ORDER.map((value) => (
            <option key={value} value={value}>
              {VOICE_COPY.fallback.screens[value]}
            </option>
          ))}
        </select>
        <label className="voice-label" htmlFor={`${id}-lot`}>
          {VOICE_COPY.fallback.idLabel}
        </label>
        <input
          id={`${id}-lot`}
          className="voice-control voice-control-mono"
          placeholder={VOICE_COPY.fallback.idPlaceholder}
          value={lotId}
          disabled={!needsId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            setLotId(event.target.value);
            setRefusal(null);
          }}
        />
        <button type="submit" className="voice-button voice-open">
          {VOICE_COPY.fallback.open}
        </button>
        {refusal && (
          <p role="alert" className="voice-reason">
            {refusal}
          </p>
        )}
      </form>
    </section>
  );
}
