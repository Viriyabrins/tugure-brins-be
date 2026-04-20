import prisma from '../prisma/client.js';
import minioService from '../services/MinioService.js';

export default async function (fastify) {
  // Guard: only available outside production
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  fastify.get(
    '/dev-tools/data-counts',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        const [
          auditLog, notification, document, debitCreditNote, invoice,
          paymentIntent, payment, reconciliation, contractRevise, reviseLog,
          debtorRevise, record, subrogation, claim, debtor, nota,
          masterContract, bordero, batch, contract,
        ] = await Promise.all([
          prisma.auditLog.count(),
          prisma.notification.count(),
          prisma.document.count(),
          prisma.debitCreditNote.count(),
          prisma.invoice.count(),
          prisma.paymentIntent.count(),
          prisma.payment.count(),
          prisma.reconciliation.count(),
          prisma.contractRevise.count(),
          prisma.reviseLog.count(),
          prisma.debtorRevise.count(),
          prisma.record.count(),
          prisma.subrogation.count(),
          prisma.claim.count(),
          prisma.debtor.count(),
          prisma.nota.count(),
          prisma.masterContract.count(),
          prisma.bordero.count(),
          prisma.batch.count(),
          prisma.contract.count(),
        ]);

        const database = {
          masterContract, batch, debtor, bordero, claim, subrogation,
          nota, record, document, invoice, payment, paymentIntent,
          debitCreditNote, reconciliation, contractRevise, debtorRevise,
          reviseLog, auditLog, notification, contract,
        };

        // Count S3 files per prefix
        const s3Prefixes = ['master-contract/', 'claim/', 'batch/', 'subrogation/'];
        const s3 = {};
        for (const prefix of s3Prefixes) {
          try {
            const files = await minioService.listFilesByPath(prefix);
            s3[prefix] = files.length;
          } catch {
            s3[prefix] = 0;
          }
        }

        const totalDb = Object.values(database).reduce((s, v) => s + v, 0);
        const totalS3 = Object.values(s3).reduce((s, v) => s + v, 0);

        return reply.send({
          success: true,
          data: { database, s3, totalDb, totalS3 },
        });
      } catch (err) {
        request.log.error(err, 'dev-tools data-counts failed');
        return reply.status(500).send({
          success: false,
          message: `Failed to fetch counts: ${err.message}`,
        });
      }
    }
  );

  fastify.delete(
    '/dev-tools/reset-all-data',
    { preHandler: fastify.authenticate },
    async (request, reply) => {
      try {
        const dbResults = await prisma.$transaction((tx) => {
          return Promise.all([
            tx.auditLog.deleteMany(),
            tx.notification.deleteMany(),
            tx.document.deleteMany(),
            tx.debitCreditNote.deleteMany(),
            tx.invoice.deleteMany(),
            tx.paymentIntent.deleteMany(),
            tx.payment.deleteMany(),
            tx.reconciliation.deleteMany(),
            tx.contractRevise.deleteMany(),
            tx.reviseLog.deleteMany(),
            tx.debtorRevise.deleteMany(),
            tx.record.deleteMany(),
            tx.subrogation.deleteMany(),
            tx.claim.deleteMany(),
            tx.debtor.deleteMany(),
            tx.nota.deleteMany(),
            tx.masterContract.deleteMany(),
            tx.bordero.deleteMany(),
            tx.batch.deleteMany(),
            tx.contract.deleteMany(),
          ]).then((results) => {
            return {
              auditLog: results[0].count,
              notification: results[1].count,
              document: results[2].count,
              debitCreditNote: results[3].count,
              invoice: results[4].count,
              paymentIntent: results[5].count,
              payment: results[6].count,
              reconciliation: results[7].count,
              contractRevise: results[8].count,
              reviseLog: results[9].count,
              debtorRevise: results[10].count,
              record: results[11].count,
              subrogation: results[12].count,
              claim: results[13].count,
              debtor: results[14].count,
              nota: results[15].count,
              masterContract: results[16].count,
              bordero: results[17].count,
              batch: results[18].count,
              contract: results[19].count,
            };
          });
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
