"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { accessMessages } from "@/lib/access-messages";
import { type CommandKind, createCommand } from "@/lib/commands";
import { parseMoneyInput, parseTonnesInput } from "@/lib/format";
import {
  bankFileProblem,
  bankUploadFailed,
  loadingUploadFailed,
  uploadEvidenceFile,
} from "./bank-upload";
import { browserSession, commandFailureMessage, type FailureNames } from "./messages";

// One lending action: a button that opens its dialog, the fields that become the command's args,
// and createCommand, then the command page (live-lending.md §6.9.5). The program decides; this
// only collects what the API needs.

export type FormField = {
  name: string;
  label: string;
  kind: "money" | "tonnes" | "integer" | "text" | "datetime" | "select";
  currency?: string;
  digits?: number;
  initial?: string;
  hint?: string;
  half?: boolean;
  options?: { value: string; label: string }[];
};

export type CommandFormProps = {
  action: string;
  kind: CommandKind;
  /** the context's organisation uuid (`memberships.id`) */
  organisationId: string;
  /** the context slug, for the command page's path */
  context: string;
  /** args fixed by the screen: addresses and ids */
  args: Record<string, string>;
  fields?: FormField[];
  /**
   * a bank or evidence file, uploaded and finalized before the command is created. `purpose`
   * defaults to bank (subject the lot_id); a loading document is subject `subjectRef`, the lot's
   * chain address (live-lending.md §6.10.3).
   */
  upload?: {
    label: string;
    ownerOrganisationId: string;
    lotId: string;
    purpose?: "bank" | "loading";
    subjectRef?: string;
    hint?: string;
  };
  /** the confirm step of an action without fields, or the dialog's body */
  confirm?: string;
  /** a second body line (the replace note, §6.10.6) */
  note?: string;
  /** a fact list after the body (T064b.4 pre-check fold 2) */
  facts?: { label: string; value: string }[];
  /** a line above the buttons (T064b.4 pre-check fold 2) */
  foot?: string;
  /** the names a refusal reads (§6.10.6); plain data, so a server component can pass it */
  names?: FailureNames;
  primary?: boolean;
};

const fieldErrors: Record<FormField["kind"], (label: string) => string> = {
  money: () => "Enter an amount like 600000.00.",
  tonnes: () => "Enter tonnes like 2000 or 2000.5.",
  integer: () => "Enter a whole number, like 1200.",
  text: (label) => `Enter the ${label.toLowerCase()}.`,
  datetime: () => "Enter the date and time.",
  select: (label) => `Choose the ${label.toLowerCase()}.`,
};

function argOf(field: FormField, raw: string): string | null {
  switch (field.kind) {
    case "money": {
      const minor = parseMoneyInput(raw, field.digits ?? 0);
      return minor === null ? null : minor.toString();
    }
    case "tonnes": {
      const kg = parseTonnesInput(raw);
      return kg === null ? null : kg.toString();
    }
    case "integer":
      return /^[0-9]+$/.test(raw) ? BigInt(raw).toString() : null;
    case "datetime": {
      // datetime-local is the browser's local time; the chain counts whole seconds.
      const ms = new Date(raw).getTime();
      return raw === "" || !Number.isFinite(ms) ? null : String(Math.floor(ms / 1000));
    }
    default:
      return raw.trim() === "" ? null : raw.trim();
  }
}

export function CommandForm({
  action,
  kind,
  organisationId,
  context,
  args,
  fields = [],
  upload,
  confirm,
  note,
  facts,
  foot,
  names = {},
  primary = false,
}: CommandFormProps) {
  const router = useRouter();
  const id = useId();
  const initialValues = () =>
    Object.fromEntries(
      fields.map((field) => [field.name, field.initial ?? field.options?.[0]?.value ?? ""]),
    );
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [file, setFile] = useState<File | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set before the first await, so a second submit in the same tick (Enter and a click) sends
  // nothing even before the busy state renders (T056x X2).
  const submitting = useRef(false);

  function reset(next: boolean) {
    setOpen(next);
    if (next) {
      setValues(initialValues());
      setFile(null);
      setInvalid({});
      setFailure(null);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    const parsed: Record<string, string> = {};
    const problems: Record<string, string> = {};
    for (const field of fields) {
      const arg = argOf(field, values[field.name] ?? "");
      if (arg === null) problems[field.name] = fieldErrors[field.kind](field.label);
      else parsed[field.name] = arg;
    }
    if (upload) {
      const problem = bankFileProblem(file);
      if (problem) problems.file = problem;
    }
    setInvalid(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;

    submitting.current = true;
    setBusy(true);
    let succeeded = false;
    try {
      const session = await browserSession();
      if (!session) {
        setFailure(accessMessages.login.sessionEnded);
        return;
      }
      const commandArgs = { ...args, ...parsed };
      if (upload && file) {
        const loading = upload.purpose === "loading";
        const versionId = await uploadEvidenceFile({
          file,
          ownerOrganisationId: upload.ownerOrganisationId,
          purpose: loading ? "loading" : "bank",
          subjectRef: upload.subjectRef ?? upload.lotId,
          userId: session.userId,
          token: session.token,
        });
        if (versionId === null) {
          setFailure(loading ? loadingUploadFailed : bankUploadFailed);
          return;
        }
        commandArgs.evidenceVersionId = versionId;
      }
      const created = await createCommand(
        { kind, organisationId, args: commandArgs },
        session.token,
      );
      if (!created.ok) {
        setFailure(commandFailureMessage(kind, created, names, commandArgs));
        return;
      }
      // Stay busy after a successful create: the dialog stays open until the route changes, and a
      // second click must not send a second command.
      succeeded = true;
      router.push(`/${context}/commands/${created.data.id}`);
    } finally {
      if (!succeeded) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  const fileField = upload && (
    <div className="form-field">
      <label htmlFor={`${id}-file`}>{upload.label}</label>
      <input
        id={`${id}-file`}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="form-input"
        aria-invalid={invalid.file ? true : undefined}
        aria-describedby={`${id}-file-hint${invalid.file ? ` ${id}-file-error` : ""}`}
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <span id={`${id}-file-hint`} className="form-hint">
        {upload.hint ??
          "PDF, JPEG or PNG, at most 20 MiB. Stored before anything is sent to the chain."}
      </span>
      {invalid.file && (
        <span id={`${id}-file-error`} className="form-error">
          {invalid.file}
        </span>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <button type="button" className="act-button" data-variant={primary ? undefined : "outline"}>
          {action}
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>{action}</DialogTitle>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {confirm && <p className="text-[14px]">{confirm}</p>}
          {note && <p className="text-[14px]">{note}</p>}
          {facts && facts.length > 0 && (
            <dl className="fact-list">
              {facts.map(({ label, value }) => (
                <div key={label} className="contents">
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(fields.length > 0 || upload) && (
            <div className="form-fields">
              {upload?.purpose === "loading" && fileField}
              {fields.map((field) => {
                const inputId = `${id}-${field.name}`;
                const problem = invalid[field.name];
                const described = [
                  field.hint ? `${inputId}-hint` : null,
                  problem ? `${inputId}-error` : null,
                ]
                  .filter(Boolean)
                  .join(" ");
                const shared = {
                  id: inputId,
                  name: field.name,
                  className: "form-input",
                  value: values[field.name] ?? "",
                  "aria-invalid": problem ? true : undefined,
                  "aria-describedby": described || undefined,
                  onChange: (event: { target: { value: string } }) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value })),
                };
                return (
                  <div key={field.name} className="form-field" data-half={field.half || undefined}>
                    <label htmlFor={inputId}>
                      {field.label}
                      {field.kind === "money" && field.currency ? ` (${field.currency})` : ""}
                    </label>
                    {field.kind === "select" ? (
                      <select {...shared}>
                        {field.options?.map(({ value, label }) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        {...shared}
                        type={field.kind === "datetime" ? "datetime-local" : "text"}
                        inputMode={
                          field.kind === "money" || field.kind === "tonnes"
                            ? "decimal"
                            : field.kind === "integer"
                              ? "numeric"
                              : undefined
                        }
                        autoComplete="off"
                        className={`form-input${field.kind === "text" || field.kind === "datetime" ? "" : " tabular-nums"}`}
                      />
                    )}
                    {field.hint && (
                      <span id={`${inputId}-hint`} className="form-hint">
                        {field.hint}
                      </span>
                    )}
                    {problem && (
                      <span id={`${inputId}-error`} className="form-error">
                        {problem}
                      </span>
                    )}
                  </div>
                );
              })}
              {upload && upload.purpose !== "loading" && fileField}
            </div>
          )}
          {foot && <p className="form-hint">{foot}</p>}
          {failure && (
            <p role="alert" className="form-alert">
              {failure}
            </p>
          )}
          <div className="act-row justify-end">
            <DialogClose asChild>
              <button type="button" className="act-button" data-variant="outline">
                Cancel
              </button>
            </DialogClose>
            <button type="submit" className="act-button" disabled={busy}>
              {action}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
