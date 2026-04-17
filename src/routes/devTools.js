import prisma from '../prisma/client.js';
import minioService from '../services/MinioService.js';

export default async function (fastify) {
  // Guard: only available outside production
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  fastify.delete(
    '/dev-tools/reset-all-data',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        const dbResults = await prisma.$transaction(async (tx) => {
          // Tier 1: No dependencies
          const auditLog = await tx.auditLog.deleteMany();
          const notification = await tx.notification.deleteMany();

          // Tier 2: No FK enforcement
          const document = await tx.document.deleteMany();
          const debitCreditNote = await tx.debitCreditNote.deleteMany();
          const invoice = await tx.invoice.deleteMany();
          const paymentIntent = await tx.paymentIntent.deleteMany();
          const payment = await tx.payment.deleteMany();
          const reconciliation = await tx.reconciliation.deleteMany();
          const contractRevise = await tx.contractRevise.deleteMany();
          const reviseLog = await tx.reviseLog.deleteMany();
          const debtorRevise = await tx.debtorRevise.deleteMany();

          // Tier 3: FK children
          const record = await tx.record.deleteMany();
          const subrogation = await tx.subrogation.deleteMany();
          const claim = await tx.claim.deleteMany();

          // Tier 4: FK parents
          const debtor = await tx.debtor.deleteMany();
          const nota = await tx.nota.deleteMany();
          const masterContract = await tx.masterContract.deleteMany();
          const bordero = await tx.bordero.deleteMany();
          const batch = await tx.batch.deleteMany();

          // Tier 5: Reference tables
          const contract = await tx.contract.deleteMany();

          return {
            auditLog: auditLog.count,
            notification: notification.count,
            document: document.count,
            debitCreditNote: debitCreditNote.count,
            invoice: invoice.count,
            paymentIntent: paymentIntent.count,
            payment: payment.count,
            reconciliation: reconciliation.count,
            contractRevise: contractRevise.count,
            reviseLog: reviseLog.count,
            debtorRevise: debtorRevise.count,
            record: record.count,
            subrogation: subrogation.count,
            claim: claim.count,
            debtor: debtor.count,
            nota: nota.count,
            masterContract: masterContract.count,
            bordero: bordero.count,
            batch: batch.count,
            contract: contract.count,
          };
        });

        // Delete S3 files from known prefixes
        const s3Prefixes = ['master-contract/', 'claim/', 'batch/', 'subrogation/'];
        const s3Results = {};
        for (const prefix of s3Prefixes) {
          try {
            s3Results[prefix] = await minioService.deleteAllByPrefix(prefix);
          } catch (err) {
            s3Results[prefix] = `error: ${err.message}`;
          }
        }

        const totalDbDeleted = Object.values(dbResults).reduce((sum, v) => sum + v, 0);
        const totalS3Deleted = Object.values(s3Results).reduce(
          (sum, v) => sum + (typeof v === 'number' ? v : 0),
          0
        );

        return reply.send({
          success: true,
          message: `Reset complete. Deleted ${totalDbDeleted} database records and ${totalS3Deleted} S3 files.`,
          data: { database: dbResults, s3: s3Results },
        });
      } catch (err) {
        request.log.error(err, 'dev-tools reset failed');
        return reply.status(500).send({
          success: false,
          message: `Reset failed: ${err.message}`,
        });
      }
    }
  );
}
