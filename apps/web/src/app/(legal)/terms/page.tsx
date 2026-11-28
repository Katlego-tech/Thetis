import type { Metadata } from "next";
import { LegalDocument, type LegalSection, SOURCE_URL } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The terms for using the Thetis devnet demo, on the web and on Android.",
};

const sections: LegalSection[] = [
  {
    id: "what",
    title: "What Thetis is",
    body: (
      <>
        <p>
          Thetis is a demonstration of software that coordinates evidence, collateral locks,
          payment-confirmed releases and custody of mineral lots on the inland journey from
          stockpile to port. It is published by Katlego Tlhapiso, an individual developer, as the
          Thetis web app and the Thetis field app for Android.
        </p>
        <p>
          Thetis is not a custody, lending, payment or brokerage service. Nothing in it is an offer
          of credit, a valuation, a warehouse receipt or a title document, and nothing in it is
          financial, legal or trade advice.
        </p>
      </>
    ),
  },
  {
    id: "devnet",
    title: "A devnet demo with no real funds",
    body: (
      <>
        <p>
          Thetis records its lots, locks, releases and handovers on Solana devnet, a public test
          network. Devnet tokens have no monetary value, and Thetis holds no real funds or real
          minerals. The organisations shown in the demo are synthetic.
        </p>
        <p>
          Never send real money, mainnet tokens or a wallet that holds them to anything in Thetis.
          Use a wallet you keep for testing.
        </p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts",
    body: (
      <ul>
        <li>
          Accounts are by invitation only. An organisation's administrator invites you by email, and
          you sign in with a code sent to that address.
        </li>
        <li>
          Keep your email account and your wallet secure. Anyone who can read your sign-in codes can
          use your Thetis account, and anyone who holds your wallet's keys can sign as you.
        </li>
        <li>
          Signing in never gives you financial authority. Only a wallet authorised on chain for an
          organisation can approve its steps, and only in your own wallet app.
        </li>
        <li>An administrator can end your membership at any time.</li>
      </ul>
    ),
  },
  {
    id: "use",
    title: "Using it fairly",
    body: (
      <ul>
        <li>
          Upload only documents you are entitled to share with the organisations you work with.
          Finalised files cannot be deleted, so do not upload personal or confidential material the
          demo does not need.
        </li>
        <li>
          Do not try to reach data you have not been given, to disrupt the service, or to use it for
          anything unlawful.
        </li>
        <li>
          Voice is optional. When you use it, your audio goes to ElevenLabs under its terms, as the{" "}
          <a href="/privacy#collect">privacy notice</a> explains.
        </li>
      </ul>
    ),
  },
  {
    id: "chain",
    title: "What the chain records",
    body: (
      <p>
        A transaction you approve is public and permanent once it lands on Solana devnet. Thetis
        shows a step as done only when the program on chain confirms it; until then a step is
        awaiting signatures, submitted or failed, and you should treat it that way.
      </p>
    ),
  },
  {
    id: "availability",
    title: "Availability",
    body: (
      <p>
        The demo can change, pause or be reset at any time, including its devnet records and its
        synthetic organisations, and accounts may be removed when the demo ends. Solana devnet is
        itself a test network that can be slow, unavailable or reset by its operators.
      </p>
    ),
  },
  {
    id: "warranty",
    title: "No warranty",
    body: (
      <p>
        Thetis is provided as it is, without any warranty. To the extent the law allows, the
        publisher is not liable for any loss that comes from using it, including a decision taken on
        what it shows.
      </p>
    ),
  },
  {
    id: "source",
    title: "Source code and questions",
    body: (
      <p>
        The source code is public at <a href={SOURCE_URL}>github.com/Katlego-tech/Thetis</a>. Open
        an issue there to ask a question or report a problem. When these terms change, the date at
        the top changes with them, and using Thetis after that means you accept the new terms.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      page="terms"
      intro={
        <p>
          These terms apply when you use Thetis on the web or on Android. They are short because
          Thetis is a demo: it runs on a test network and moves no real money.
        </p>
      }
      sections={sections}
    />
  );
}
