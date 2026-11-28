import { RegistryMark } from "@/components/thetis/registry-mark";
import type { Step } from "@/data/judge/steps";
import { shorten } from "@/data/judge/steps";
import { formatSlot } from "@/lib/format";

export function ExplorerLink({ step }: { step: Step }) {
  const text =
    step.kind === "refusal"
      ? "Failed transaction on the explorer"
      : `Transaction ${shorten(step.signature)}`;
  return (
    <a href={step.explorerUrl} title={step.signature} rel="noreferrer">
      {text}
    </a>
  );
}

export function StepFacts({ step }: { step: Step }) {
  if (step.facts.length === 0) return null;
  return (
    <dl className="judge-facts">
      {step.facts.map((fact, i) => (
        // A step may carry the same label twice (two loans handed off in one loading).
        // biome-ignore lint/suspicious/noArrayIndexKey: facts are a fixed list per render
        <div key={`${fact.label}-${i}`}>
          <dt>{fact.label}</dt>
          <dd
            className={
              fact.mono ? (step.kind === "refusal" ? "judge-error" : "judge-mono") : undefined
            }
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StepRow({ step }: { step: Step }) {
  return (
    <li
      className="judge-step"
      data-kind={step.kind}
      data-mark={step.mark}
      data-signature={step.signature}
    >
      <h3>{step.title}</h3>
      <RegistryMark status={step.mark} />
      {step.signedBy.length > 0 ? (
        <p className="judge-who">Signed by {joinNames(step.signedBy)}</p>
      ) : null}
      <StepFacts step={step} />
      <p className="judge-tx">
        <span>Slot {formatSlot(BigInt(step.slot))}</span>
        <ExplorerLink step={step} />
      </p>
    </li>
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function SetupSummary({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  const groups = new Map<string, Step[]>();
  for (const step of steps) {
    const group = groups.get(step.instruction) ?? [];
    group.push(step);
    groups.set(step.instruction, group);
  }
  return (
    <li className="judge-setup">
      <details>
        <summary>Before the run: {steps.length} setup transactions</summary>
        <ul className="judge-setup-list">
          {[...groups].map(([instruction, group]) => (
            <li key={instruction}>
              {instruction}, {group.length}
              <ul>
                {group.map((step) => (
                  <li key={step.signature}>
                    <ExplorerLink step={step} />
                    {step.facts.length > 0
                      ? `: ${step.facts.map((f) => `${f.label} ${f.value}`).join("; ")}`
                      : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

export function StepSpine({ steps }: { steps: Step[] }) {
  const setup = steps.filter((s) => s.kind === "setup");
  const rest = steps.filter((s) => s.kind !== "setup");
  return (
    <ol className="judge-spine">
      <SetupSummary steps={setup} />
      {rest.map((step) => (
        <StepRow key={`${step.kind}-${step.signature}`} step={step} />
      ))}
    </ol>
  );
}
