const notes = {
  halted:
    "Indexing has stopped, so this lot may have changed since. The figures below may be out of date.",
  skew: "This lot's supply and holder quantities were read at different moments. The figures below may be out of date; reload to read them again.",
} as const;

export function LotStaleNote({ stale }: { stale: keyof typeof notes }) {
  return (
    <p role="status" className="text-[13px] text-(--refuse)">
      {notes[stale]}
    </p>
  );
}
