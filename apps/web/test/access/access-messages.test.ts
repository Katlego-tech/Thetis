import { expect, test } from "vitest";
import { accessMessages } from "@/lib/access-messages";

test("accessMessages matches the web.md 8.10 table verbatim", () => {
  const email = "naledi.dube@lender-one.example";
  const wallet = "Solflare";
  const time = "14:46:07 SAST";
  const org = "Lender One Bank";

  expect(accessMessages.login.emailInvalid).toBe(
    "Enter a full email address, like name@company.com.",
  );
  expect(accessMessages.login.rateLimited).toBe(
    "Too many codes were requested for this address. Wait a minute, then try again.",
  );
  expect(accessMessages.login.codeRejected).toBe(
    "That code is wrong or has expired. Check the newest email, or send a new code.",
  );
  expect(accessMessages.login.codeShape).toBe("Enter the 6 digits from the email.");
  expect(accessMessages.login.codeResent({ email })).toBe(
    "A new code is on its way to naledi.dube@lender-one.example. Earlier codes no longer work.",
  );
  expect(accessMessages.login.unreachable).toBe(
    "Thetis could not reach the sign-in service. Check your connection and try again.",
  );
  expect(accessMessages.login.sessionEnded).toBe(
    "Your session ended. Sign in again to continue where you were.",
  );

  expect(accessMessages.invite.incomplete).toBe(
    "Open the link from your invitation email again. If it still fails, ask the person who invited you to send a new one.",
  );
  expect(accessMessages.invite.invalid).toBe(
    "This invitation can't be used. It may have expired, been revoked, already been accepted, or been sent to a different email address.",
  );
  expect(accessMessages.invite.invalidHelp).toBe(
    "If you accepted it before, your organisations are listed on your account page. Otherwise ask the person who invited you for a new invitation.",
  );
  expect(accessMessages.invite.failed).toBe(
    "Thetis could not accept the invitation. Check your connection and try again.",
  );

  expect(accessMessages.account.noWallets).toBe(
    "No wallets linked yet. Link one with the panel on this page.",
  );
  expect(accessMessages.account.noMembership).toBe(
    "You are not a member of any organisation yet. Open the invitation link from your email to join one.",
  );
  expect(accessMessages.account.loadFailed).toBe(
    "Thetis could not load your wallets and organisations. Reload the page to try again.",
  );
  expect(accessMessages.account.revokeAlready).toBe(
    "This link was already revoked. The list now shows its current state.",
  );
  expect(accessMessages.account.revokeNotAllowed).toBe(
    "You can't revoke this link. Only its owner or an admin of its organisation can.",
  );

  expect(accessMessages.account.revokeFailed).toBe(
    "Thetis could not confirm the revoke. The list below shows each link's current state; if the link is still active, try again.",
  );

  expect(accessMessages.account.refreshFailed).toBe(
    "Thetis could not refresh this list, so it may be out of date. Refresh it to try again.",
  );
  expect(accessMessages.link.unconfirmed({ wallet })).toBe(
    "Thetis could not confirm whether Solflare was linked. Check again before you sign a new message.",
  );

  expect(accessMessages.link.noWallet).toBe(
    "No browser wallet that can sign messages was found. Install Solflare for this browser, then reload the page.",
  );
  expect(accessMessages.link.connectRefused({ wallet })).toBe(
    "Solflare did not connect. Nothing was linked.",
  );
  expect(accessMessages.link.signCancelled({ wallet, time })).toBe(
    "You cancelled in Solflare. Nothing was linked. This message stays valid until 14:46:07 SAST.",
  );
  expect(accessMessages.link.badSignature({ wallet })).toBe(
    "Solflare returned a signature that does not match the exact text above. Nothing was linked.",
  );
  expect(accessMessages.link.badSignatureHelp).toBe(
    "Some wallets change the text before signing it. Try another wallet, and report the wallet name with this message.",
  );
  expect(accessMessages.link.expired({ time })).toBe(
    "This message expired at 14:46:07 SAST, or was already used. Nothing was linked.",
  );
  expect(accessMessages.link.alreadyLinked).toBe(
    "This wallet is already linked to a Thetis account. A wallet can have only one active link.",
  );
  expect(accessMessages.link.alreadyLinkedHelp).toBe(
    "If the link is yours, it is listed under Linked wallets. Otherwise revoke it from the account that holds it, or connect a different wallet.",
  );
  expect(accessMessages.link.notMember({ org })).toBe(
    "You are no longer a member of Lender One Bank, so you can't link a wallet for it.",
  );
  expect(accessMessages.link.walletInvalid({ wallet })).toBe(
    "Solflare offered an account that is not a Solana wallet address. Choose a Solana account in Solflare and connect again.",
  );
  expect(accessMessages.link.failed).toBe(
    "Thetis could not complete the link. Nothing was linked. Try again.",
  );
});
