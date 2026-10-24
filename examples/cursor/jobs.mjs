/** Unsafe: writes the balance the cursor read, which is as old as the cursor's snapshot. */
export async function applyInterest(writer, account) {
  await writer.query('UPDATE accounts SET balance = $1 WHERE id = $2', [(Number(account.balance) * 1.1).toFixed(2), account.id]);
}

/** Safe: computes the new balance from the row as it is when the update runs. */
export async function applyInterestAtomically(writer, account) {
  await writer.query('UPDATE accounts SET balance = round(balance * 1.1, 2) WHERE id = $1', [account.id]);
}
