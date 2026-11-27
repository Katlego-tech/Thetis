import { CommandForm, type FormField } from "@/components/commands/command-form";
import { RegistryMark } from "@/components/thetis/registry-mark";
import { ResultTable } from "@/components/thetis/result-table";
import type { LiveLoan } from "@/data/live/types";
import { formatClockTime, formatMoney, formatTonnes } from "@/lib/format";
import { type LendingActions, loanStatusLabels } from "./lending-copy";

// One loan on the lot, in its own facility's currency (live-lending.md §6.9.2 LoanBlock, decision 3).

const controlLabels: Record<LiveLoan["lock"]["control"], string> = {
  Pledged: "Lender's pledge",
  Recovery: "Lender's recovery control",
};

export function LoanBlock({
  loan,
  lotId,
  context,
  actions,
}: {
  loan: LiveLoan;
  lotId: string;
  context: string;
  actions: LendingActions | null;
}) {
  const { facility } = loan;
  const money = (minor: bigint) => formatMoney(minor, facility.currency, facility.currencyDecimals);
  const isLender = facility.lender.id === context;
  const isBorrower = facility.borrower.id === context;
  const moneyField = (name: string, label: string, initial?: string): FormField => ({
    name,
    label,
    kind: "money",
    currency: facility.currency,
    digits: facility.currencyDecimals,
    ...(initial === undefined ? {} : { initial }),
  });
  const form = actions && {
    organisationId: actions.organisationId,
    context,
  };
  const bankFile = actions && {
    label: "Bank confirmation",
    ownerOrganisationId: actions.organisationId,
    lotId,
  };
  const showActions = Boolean(form) && (isLender || isBorrower) && loan.status !== "Closed";
  const lenderActs = isLender && form && bankFile;

  return (
    <div className="work-panel">
      <div className="block-heading">
        <h3>
          Loan {loan.index.toString()}, {facility.lender.name}
        </h3>
        <span className="act-row">
          <span className="thetis-mark border border-(--ink-2) border-dashed">
            {loanStatusLabels[loan.status]}
          </span>
          <RegistryMark status={loan.registry.status} />
        </span>
      </div>
      <div className="flex flex-col gap-4">
        <div className="pair-table">
          <ResultTable
            columns={[
              { key: "result", label: "Result" },
              { key: "value", label: "Value" },
            ]}
            totalRowIndex={2}
            rows={[
              { result: "Principal", value: money(loan.principalMinor) },
              {
                result: "Interest",
                value: `${money(loan.bookedInterestMinor)} booked, ${money(loan.accruedInterestMinor)} accrued to ${formatClockTime(loan.asOf)}`,
              },
              { result: "Debt", value: money(loan.debtMinor) },
              { result: "Locked quantity", value: formatTonnes(loan.lock.quantityKg) },
              { result: "Control", value: controlLabels[loan.lock.control] },
              { result: "Revision", value: loan.revision.toString() },
              { result: "Open corrections", value: loan.openExceptions.toString() },
            ]}
          />
        </div>
        {loan.payments.length === 0 ? (
          <p className="text-(--ink-2)">No payments recorded for this loan.</p>
        ) : (
          <ResultTable
            columns={[
              { key: "purpose", label: "Purpose" },
              { key: "amount", label: "Amount", align: "right" },
              { key: "status", label: "Status" },
              { key: "applied", label: "Applied", align: "right" },
              { key: "surplus", label: "Surplus", align: "right" },
              { key: "registry", label: "Registry" },
              ...(lenderActs ? [{ key: "action", label: "Action" }] : []),
            ]}
            rows={loan.payments.map((payment) => ({
              purpose: payment.purpose,
              amount: money(payment.amountMinor),
              status: payment.status,
              applied: money(payment.appliedMinor),
              surplus: money(payment.surplusMinor),
              registry: <RegistryMark status={payment.registry.status} />,
              action: lenderActs ? (
                <span className="act-row">
                  {payment.purpose === "Repayment" &&
                    payment.status === "Unconsumed" &&
                    loan.status !== "Closed" && (
                      <CommandForm
                        {...form}
                        action="Apply repayment"
                        kind="repay"
                        args={{ payment: payment.address }}
                        confirm={`Apply ${money(payment.amountMinor)} to loan ${loan.index}?`}
                        primary
                      />
                    )}
                  {payment.purpose !== "Correction" && payment.status !== "Voided" && (
                    <CommandForm
                      {...form}
                      action="Correct payment"
                      kind="correct_payment"
                      args={{ target: payment.address }}
                      fields={[
                        {
                          name: "correctionReference",
                          label: "Correction reference",
                          kind: "text",
                        },
                      ]}
                      upload={{ ...bankFile, label: "Evidence" }}
                    />
                  )}
                </span>
              ) : null,
            }))}
          />
        )}
      </div>
      {showActions && form && (
        <div className="act-row">
          {lenderActs && loan.status === "Active" && (
            <CommandForm
              {...form}
              action="Record advance"
              kind="record_advance"
              args={{ loan: loan.address }}
              fields={[moneyField("amountMinor", "Amount")]}
              primary
            />
          )}
          {lenderActs && (
            <CommandForm
              {...form}
              action="Confirm repayment"
              kind="confirm_payment"
              args={{ loan: loan.address, purpose: "Repayment" }}
              fields={[
                moneyField("amountMinor", "Amount"),
                { name: "bankReference", label: "Bank reference", kind: "text", half: true },
                { name: "observedAt", label: "Observed at", kind: "datetime", half: true },
              ]}
              upload={bankFile}
            />
          )}
          {lenderActs && loan.status === "Active" && (
            <CommandForm
              {...form}
              action="Move to recovery"
              kind="liquidate"
              args={{ loan: loan.address }}
              confirm={`Move loan ${loan.index} to recovery? Ownership and custody don't change.`}
            />
          )}
          {lenderActs && (
            <CommandForm
              {...form}
              action="Close loan"
              kind="close_loan"
              args={{ loan: loan.address }}
              confirm={`Close loan ${loan.index}? The lock is released if the debt is zero.`}
            />
          )}
          {isBorrower && actions && loan.status === "Active" && (
            <CommandForm
              {...form}
              action="Create release intent"
              kind="create_release_intent"
              args={{ loan: loan.address }}
              fields={[
                { name: "buyer", label: "Buyer", kind: "select", options: actions.buyers },
                { name: "quantityKg", label: "Quantity in tonnes", kind: "tonnes" },
                moneyField("priceMinor", "Price"),
                { ...moneyField("topUpMinor", "Top-up", "0"), half: true },
                {
                  name: "expiresInHours",
                  label: "Expires in hours",
                  kind: "integer",
                  initial: "24",
                  half: true,
                },
              ]}
              primary
            />
          )}
        </div>
      )}
    </div>
  );
}
