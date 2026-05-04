import { EntityRepository } from '../repositories/EntityRepository.js';
import prisma from '../prisma/client.js';

/**
 * Middleware to ensure only superadmin can access admin routes
 */
async function ensureSuperAdmin(request, reply) {
  if (!request.user?.isSuperAdmin) {
    const err = new Error('Forbidden: Admin access required');
    err.statusCode = 403;
    throw err;
  }
}

export default async function (fastify) {
  const repository = new EntityRepository(fastify.db);

  /**
   * GET /admin/transactions (served as /api/admin/transactions)
   * Query all transactions across entity types with filtering
   * Query params:
   *   - entityType: Batch, Debtor, Claim, Nota, etc. (optional)
   *   - userEmail: filter by user (optional)
   *   - status: filter by status (optional)
   *   - startDate: from date (ISO string, optional)
   *   - endDate: to date (ISO string, optional)
   *   - page: pagination (default: 1)
   *   - limit: per page (default: 50)
   */
  fastify.get(
    '/admin/transactions',
    { preHandler: [fastify.authenticate, ensureSuperAdmin] },
    async (request, reply) => {
      try {
        const {
          entityType = null,
          userEmail = null,
          status = null,
          startDate = null,
          endDate = null,
          page = 1,
          limit = 50,
        } = request.query;

        const pageNum = Math.max(1, parseInt(page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit) || 50));
        const skip = (pageNum - 1) * pageSize;

        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) dateFilter.lte = new Date(endDate);

        const transactions = [];
        let totalCount = 0;

        // Query Batch
        if (!entityType || entityType === 'Batch') {
          const where = {};
          if (status) where.status = status;
          if (Object.keys(dateFilter).length) where.uploaded_date = dateFilter;

          const batches = await prisma.batch.findMany({
            where,
            select: {
              batch_id: true,
              status: true,
              total_records: true,
              total_exposure: true,
              total_premium: true,
              uploaded_by: true,
              uploaded_date: true,
            },
            take: pageSize,
            skip: entityType === 'Batch' ? skip : 0,
          });

          const batchCount = await prisma.batch.count({ where });
          if (entityType === 'Batch') totalCount = batchCount;

          transactions.push(
            ...batches.map(b => ({
              type: 'Batch',
              id: b.batch_id,
              key: b.batch_id,
              status: b.status,
              totalRecords: b.total_records,
              totalExposure: parseFloat(b.total_exposure || 0),
              totalPremium: parseFloat(b.total_premium || 0),
              user: b.uploaded_by,
              timestamp: b.uploaded_date,
            }))
          );
        }

        // Query Debtor
        if (!entityType || entityType === 'Debtor') {
          const where = {};
          if (status) where.status = status;
          if (Object.keys(dateFilter).length) where.tanggal_terima = dateFilter;

          const debtors = await prisma.debtor.findMany({
            where,
            select: {
              id: true,
              batch_id: true,
              status: true,
              plafon: true,
              net_premi: true,
              tanggal_terima: true,
            },
            take: pageSize,
            skip: entityType === 'Debtor' ? skip : 0,
          });

          const debtorCount = await prisma.debtor.count({ where });
          if (entityType === 'Debtor') totalCount = debtorCount;

          transactions.push(
            ...debtors.map(d => ({
              type: 'Debtor',
              id: d.id,
              key: d.id,
              batchId: d.batch_id,
              status: d.status,
              plafon: parseFloat(d.plafon || 0),
              netPremi: parseFloat(d.net_premi || 0),
              timestamp: d.tanggal_terima,
            }))
          );
        }

        // Query Claim
        if (!entityType || entityType === 'Claim') {
          const where = {};
          if (status) where.status = status;
          if (Object.keys(dateFilter).length) where.dol = dateFilter;

          const claims = await prisma.claim.findMany({
            where,
            select: {
              claim_no: true,
              status: true,
              nilai_klaim: true,
              share_tugure_percentage: true,
              share_tugure_amount: true,
              dol: true,
            },
            take: pageSize,
            skip: entityType === 'Claim' ? skip : 0,
          });

          const claimCount = await prisma.claim.count({ where });
          if (entityType === 'Claim') totalCount = claimCount;

          transactions.push(
            ...claims.map(c => ({
              type: 'Claim',
              id: c.claim_no,
              key: c.claim_no,
              status: c.status,
              nilaiKlaim: parseFloat(c.nilai_klaim || 0),
              shareTugure: parseFloat(c.share_tugure_amount || 0),
              timestamp: c.dol,
            }))
          );
        }

        // Sort by timestamp descending
        transactions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        reply.send({
          success: true,
          data: {
            transactions: transactions.slice(0, pageSize),
            pagination: {
              page: pageNum,
              limit: pageSize,
              total: totalCount || transactions.length,
            },
          },
        });
      } catch (error) {
        console.error('[Admin Transactions] Error:', error.message);
        reply.status(500).send({
          success: false,
          message: 'Failed to fetch transactions',
          error: error.message,
        });
      }
    }
  );

  /**
   * GET /api/admin/audit-log
   * Query all-time audit log with filtering and pagination
   * Query params:
   *   - action: filter by action (optional)
   *   - module: filter by module (optional)
   *   - userEmail: filter by user email (optional)
   *   - startDate: from date (ISO string, optional)
   *   - endDate: to date (ISO string, optional)
   *   - page: pagination (default: 1)
   *   - limit: per page (default: 50)
   */
  fastify.get(
    '/admin/audit-log',
    { preHandler: [fastify.authenticate, ensureSuperAdmin] },
    async (request, reply) => {
      try {
        const {
          action = null,
          module = null,
          userEmail = null,
          startDate = null,
          endDate = null,
          page = 1,
          limit = 50,
        } = request.query;

        const pageNum = Math.max(1, parseInt(page) || 1);
        const pageSize = Math.min(200, Math.max(1, parseInt(limit) || 50));
        const skip = (pageNum - 1) * pageSize;

        const where = {};
        if (action) where.action = { contains: action, mode: 'insensitive' };
        if (module) where.module = module;
        if (userEmail) where.user_email = { contains: userEmail, mode: 'insensitive' };

        if (startDate || endDate) {
          where.created_at = {};
          if (startDate) where.created_at.gte = new Date(startDate);
          if (endDate) where.created_at.lte = new Date(endDate);
        }

        const logs = await prisma.auditLog.findMany({
          where,
          select: {
            id: true,
            action: true,
            module: true,
            entity_type: true,
            entity_id: true,
            user_email: true,
            user_role: true,
            old_value: true,
            new_value: true,
            reason: true,
            created_at: true,
          },
          orderBy: { created_at: 'desc' },
          take: pageSize,
          skip,
        });

        const total = await prisma.auditLog.count({ where });

        reply.send({
          success: true,
          data: {
            logs: logs.map(log => ({
              id: log.id,
              action: log.action,
              module: log.module,
              entityType: log.entity_type,
              entityId: log.entity_id,
              user: log.user_email,
              role: log.user_role,
              oldValue: log.old_value ? JSON.parse(log.old_value) : null,
              newValue: log.new_value ? JSON.parse(log.new_value) : null,
              reason: log.reason,
              timestamp: log.created_at,
            })),
            pagination: {
              page: pageNum,
              limit: pageSize,
              total,
            },
          },
        });
      } catch (error) {
        console.error('[Admin Audit Log] Error:', error.message);
        reply.status(500).send({
          success: false,
          message: 'Failed to fetch audit log',
          error: error.message,
        });
      }
    }
  );

  /**
   * GET /api/admin/dashboard-kpi
   * Aggregate KPIs across both realms (all-time)
   * Optional query params:
   *   - startDate: from date (ISO string, optional)
   *   - endDate: to date (ISO string, optional)
   */
  fastify.get(
    '/admin/dashboard-kpi',
    { preHandler: [fastify.authenticate, ensureSuperAdmin] },
    async (request, reply) => {
      try {
        const { startDate = null, endDate = null } = request.query;

        const dateFilter = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) dateFilter.lte = new Date(endDate);

        // Batches
        const batchWhere = Object.keys(dateFilter).length ? { uploaded_date: dateFilter } : {};
        const totalBatches = await prisma.batch.count({ where: batchWhere });
        const batchData = await prisma.batch.aggregate({
          where: batchWhere,
          _sum: {
            total_exposure: true,
            total_premium: true,
            final_premium_amount: true,
          },
        });

        // Debtors
        const debtorWhere = Object.keys(dateFilter).length ? { created_at: dateFilter } : {};
        const totalDebtors = await prisma.debtor.count({ where: debtorWhere });
        const debtorData = await prisma.debtor.aggregate({
          where: debtorWhere,
          _sum: {
            plafon: true,
            net_premi: true,
          },
        });

        // Claims
        const claimWhere = Object.keys(dateFilter).length ? { claim_date: dateFilter } : {};
        const totalClaims = await prisma.claim.count({ where: claimWhere });
        const claimData = await prisma.claim.aggregate({
          where: claimWhere,
          _sum: {
            nilai_klaim: true,
            share_tugure_amount: true,
          },
        });

        // User activity count (by email)
        const auditWhere = Object.keys(dateFilter).length ? { created_at: dateFilter } : {};
        const userActivity = await prisma.auditLog.groupBy({
          by: ['user_email'],
          where: auditWhere,
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 20,
        });

        const totalExposure = parseFloat(batchData._sum.total_exposure || 0);
        const totalGrossPremium = parseFloat(batchData._sum.total_premium || 0);
        const totalNetPremium = parseFloat(debtorData._sum.net_premi || 0);
        const totalClaimAmount = parseFloat(claimData._sum.nilai_klaim || 0);
        const totalTugureShare = parseFloat(claimData._sum.share_tugure_amount || 0);

        reply.send({
          success: true,
          data: {
            kpis: {
              totalBatches,
              totalDebtors,
              totalClaims,
              totalExposure,
              totalGrossPremium,
              totalNetPremium,
              totalClaimAmount,
              totalTugureShare,
            },
            userActivity: userActivity.map(u => ({
              user: u.user_email,
              actionCount: u._count.id,
            })),
            summary: {
              batchesProcessed: totalBatches,
              debtorsReviewed: totalDebtors,
              claimsProcessed: totalClaims,
              exposureAtRisk: totalExposure,
              premiumCollected: totalNetPremium,
              claimsAmount: totalClaimAmount,
              reinsuranceShare: totalTugureShare,
            },
          },
        });
      } catch (error) {
        console.error('[Admin Dashboard KPI] Error:', error.message);
        reply.status(500).send({
          success: false,
          message: 'Failed to fetch dashboard KPI',
          error: error.message,
        });
      }
    }
  );
}
