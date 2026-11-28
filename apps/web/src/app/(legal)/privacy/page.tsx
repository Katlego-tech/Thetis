import type { Metadata } from "next";
import { LegalDocument, type LegalSection, SOURCE_URL } from "@/components/legal/legal-document";

export const metadata: Metadata = {
  title: "Privacy notice",
  description: "What the Thetis web and field apps collect, where it goes and who can see it.",
};

const sections: LegalSection[] = [
  {
    id: "collect",
    title: "What Thetis collects",
    body: (
      <>
        <h3>Your email address and sign-in codes</h3>
        <p>
          An administrator of an organisation invites you by email address. Thetis creates your
          account with that address and no password. Each time you sign in, Thetis sends a six-digit
          code to the address, and the code gives you a session. The invitation itself is stored
          only as a fingerprint of its link, which expires after seven days.
        </p>
        <h3>Organisation membership</h3>
        <p>
          Thetis records which organisations you belong to and your role in each, administrator or
          member, with who invited you and when you accepted.
        </p>
        <h3>Wallet public keys</h3>
        <p>
          You can link a Solana wallet to your account by signing a one-time message with it. Thetis
          stores the wallet's public key, the message and the time it was linked. The message never
          authorises a transaction. Thetis never sees or stores a private key or a recovery phrase.
        </p>
        <h3>Evidence files</h3>
        <p>
          You can upload documents about a lot, such as weighbridge tickets, assay certificates and
          origin documents, as PDF, JPEG or PNG files of up to 20 MiB. Thetis stores the original
          file, its type, size and SHA-256 digest, who uploaded it and when.
        </p>
        <h3>Voice</h3>
        <p>
          Voice is optional and starts only when you press Talk. While a conversation is open, your
          microphone audio is streamed to ElevenLabs, a third-party voice service, which runs the
          assistant that opens screens and reads out which evidence is recorded for a lot.
          ElevenLabs processes that audio under its own terms and privacy policy. It never receives
          a Thetis password, code or session: the lookups it asks for run on your device with your
          own permissions.
        </p>
        <h3>Records on Solana devnet</h3>
        <p>
          When you approve a transaction in your wallet, it is sent to Solana devnet. Everything a
          transaction carries, including wallet addresses, lot identifiers, quantities and document
          digests, becomes part of a public ledger that anyone can read and that cannot be changed
          or deleted, by Thetis or anyone else.
        </p>
        <h3>On your phone</h3>
        <p>
          The field app keeps your session in Android's secure storage, and keeps an encrypted copy
          of the last organisation and wallet details it read so it can open without a network. It
          uses the camera only when you choose to photograph a document, and opens your files only
          when you choose one. Wallet signing happens in your own wallet app.
        </p>
        <h3>An activity record</h3>
        <p>
          Thetis keeps an append-only record of actions such as sending and accepting invitations,
          linking wallets and finalising evidence, with the account and the time of each.
        </p>
      </>
    ),
  },
  {
    id: "not-collected",
    title: "What Thetis does not collect",
    body: (
      <ul>
        <li>No passwords, private keys or recovery phrases.</li>
        <li>No advertising and no analytics or tracking scripts.</li>
        <li>
          No location. The web app stores one setting in your browser, your light or dark theme,
          plus the cookies that keep you signed in.
        </li>
      </ul>
    ),
  },
  {
    id: "use",
    title: "How it is used",
    body: (
      <>
        <p>
          Thetis uses this information only to run the demo: to sign you in, to show you the
          organisations, lots and evidence you are allowed to see, to check that the right wallet
          signs each step, and to keep a record of who did what. It is not sold, and it is not used
          for marketing.
        </p>
      </>
    ),
  },
  {
    id: "who-sees",
    title: "Who can see it",
    body: (
      <ul>
        <li>
          Members of your organisation see its membership and its records. Other organisations see
          an evidence file only when its owner grants them access, and the grant can be revoked.
        </li>
        <li>
          Files are never public. A download link is issued only to someone allowed to read the
          file, and it stops working after 60 seconds.
        </li>
        <li>Anyone can read what is recorded on Solana devnet, because that ledger is public.</li>
        <li>
          Thetis runs on Supabase, for accounts, the database and file storage, and on Amazon Web
          Services, for its application APIs. Voice runs through ElevenLabs. These services process
          the data only to provide their part of the app.
        </li>
      </ul>
    ),
  },
  {
    id: "keep",
    title: "What can be changed or removed",
    body: (
      <ul>
        <li>An administrator can revoke your membership, and you can revoke a linked wallet.</li>
        <li>
          Evidence originals and the activity record are kept unchanged on purpose: once a file is
          finalised, nobody can alter or delete it through the app, so a later reader can trust it
          is the file that was checked. Do not upload a file you are not allowed to keep on record.
        </li>
        <li>Records on Solana devnet cannot be removed by anyone.</li>
      </ul>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <p>
        Thetis is a working tool for organisations in the mineral trade, used by invitation. It is
        not meant for children.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes and questions",
    body: (
      <p>
        When this notice changes, the date at the top changes with it. Thetis is open source: you
        can read exactly what it collects in its code at{" "}
        <a href={SOURCE_URL}>github.com/Katlego-tech/Thetis</a>, and ask a question by opening an
        issue there. Issues are public, so do not put personal information in one.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      page="privacy"
      intro={
        <p>
          Thetis coordinates evidence, collateral locks, payment-confirmed releases and custody of
          mineral lots between an exporter, a custodian, a terminal and a lender. This notice says
          what the web and field apps collect while you use the demo, why, and who can see it.
        </p>
      }
      sections={sections}
    />
  );
}
