import prisma from '../prisma/client.js';

/**
 * Fetch all context data needed by the nota management page in one round-trip.
 * Replaces 7 parallel backend.list calls from the frontend.
 */
export async function getNotaContext() {
  const [batches, contracts, payments, paymentIntents, dnCnRecords, debtors, subrogations] = await Promise.all([
    prisma.batch.findMany(),
    prisma.masterContract.findMany(),
    prisma.payment.findMany(),
    prisma.paymentIntent.findMany(),
    prisma.debitCreditNote.findMany(),
    prisma.debtor.findMany(),
    prisma.subrogation.findMany(),
  ]);
  return { batches, contracts, payments, paymentIntents, dnCnRecords, debtors, subrogations };
}

/**
 * Atomically record a payment against a Nota.
 * Creates a Payment record, updates Nota totals, and if reconStatus is MATCHED
 * also marks the Nota as PAID.
 * Replaces frontend's separate backend.create("Payment") + backend.update("Nota") calls.
 * Returns the payment reference string.
 */
export async function recordNotaPayment(notaNumber, {
  contractId,
  paidAmount,
  paymentDate,
  bankReference,
  matchStatus,
  exceptionType,
  reconStatus,
  newTotalPaid,
  userEmail,
}) {
  const paymentRef = bankReference || `PAY-${notaNumber}-${Date.now()}`;
  const parsedDate = new Date(paymentDate);

  await prisma.payment.create({
    data: {
      payment_ref: paymentRef,
      invoice_id: notaNumber,
      contract_id: contractId || '',
      amount: parseFloat(paidAmount) || 0,
      payment_date: parsedDate,
      bank_reference: bankReference || null,
      currency: 'IDR',
      match_status: matchStatus || null,
      exception_type: exceptionType || null,
      matched_by: userEmail || 'system',
      matched_date: new Date(),
      is_actual_payment: true,
    },
  });

  await prisma.nota.update({
    where: { nota_number: notaNumber },
    data: {
      total_actual_paid: parseFloat(newTotalPaid) || 0,
      reconciliation_status: reconStatus || null,
    },
  });

  if (reconStatus === 'MATCHED') {
    await prisma.nota.update({
      where: { nota_number: notaNumber },
      data: {
        status: 'PAID',
        paid_date: parsedDate,
        payment_reference: paymentRef,
      },
    });
  }

  return paymentRef;
}

export default { getNotaContext, recordNotaPayment };
