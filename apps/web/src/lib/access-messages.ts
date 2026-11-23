export const accessMessages = {
  login: {
    emailInvalid: "Enter a full email address, like name@company.com.",
    rateLimited: "Too many codes were requested for this address. Wait a minute, then try again.",
    codeRejected: "That code is wrong or has expired. Check the newest email, or send a new code.",
    codeShape: "Enter the 6 digits from the email.",
    codeResent: ({ email }: { email: string }) =>
      `A new code is on its way to ${email}. Earlier codes no longer work.`,
    unreachable: "Thetis could not reach the sign-in service. Check your connection and try again.",
    sessionEnded: "Your session ended. Sign in again to continue where you were.",
  },
  invite: {
    incomplete:
      "Open the link from your invitation email again. If it still fails, ask the person who invited you to send a new one.",
    invalid:
      "This invitation can't be used. It may have expired, been revoked, already been accepted, or been sent to a different email address.",
    invalidHelp:
      "If you accepted it before, your organisations are listed on your account page. Otherwise ask the person who invited you for a new invitation.",
    failed: "Thetis could not accept the invitation. Check your connection and try again.",
  },
  account: {
    noWallets: "No wallets linked yet. Link one with the panel on this page.",
    noMembership:
      "You are not a member of any organisation yet. Open the invitation link from your email to join one.",
    loadFailed:
      "Thetis could not load your wallets and organisations. Reload the page to try again.",
    revokeAlready: "This link was already revoked. The list now shows its current state.",
    revokeNotAllowed:
      "You can't revoke this link. Only its owner or an admin of its organisation can.",
  },
  link: {
    noWallet:
      "No browser wallet that can sign messages was found. Install Solflare for this browser, then reload the page.",
    connectRefused: ({ wallet }: { wallet: string }) =>
      `${wallet} did not connect. Nothing was linked.`,
    signCancelled: ({ wallet, time }: { wallet: string; time: string }) =>
      `You cancelled in ${wallet}. Nothing was linked. This message stays valid until ${time}.`,
    badSignature: ({ wallet }: { wallet: string }) =>
      `${wallet} returned a signature that does not match the exact text above. Nothing was linked.`,
    badSignatureHelp:
      "Some wallets change the text before signing it. Try another wallet, and report the wallet name with this message.",
    expired: ({ time }: { time: string }) =>
      `This message expired at ${time}, or was already used. Nothing was linked.`,
    alreadyLinked:
      "This wallet is already linked to a Thetis account. A wallet can have only one active link.",
    alreadyLinkedHelp:
      "If the link is yours, it is listed under Linked wallets. Otherwise revoke it from the account that holds it, or connect a different wallet.",
    notMember: ({ org }: { org: string }) =>
      `You are no longer a member of ${org}, so you can't link a wallet for it.`,
    walletInvalid: ({ wallet }: { wallet: string }) =>
      `${wallet} offered an account that is not a Solana wallet address. Choose a Solana account in ${wallet} and connect again.`,
    failed: "Thetis could not complete the link. Nothing was linked. Try again.",
  },
};
