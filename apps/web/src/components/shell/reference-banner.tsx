export function ReferenceBanner({ specimen = false }: { specimen?: boolean }) {
  return (
    <div className="reference-banner">
      {specimen ? (
        <span>
          Specimen sheet. These marks show every state; none of them describes a real record.
        </span>
      ) : (
        <>
          <strong>Design reference.</strong>{" "}
          <span>Synthetic parties and amounts. Nothing on this page is recorded on chain.</span>
        </>
      )}
    </div>
  );
}
