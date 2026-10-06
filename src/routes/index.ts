import { Router } from 'express';
import healthRoutes from './health.routes';
import salesRoutes from './sales.routes';
import shopRoutes from './shop.routes';
import homeRoutes from './home.routes';
import billsRoutes from './bills.routes';
import itemsRoutes from './items.routes';
import paymentsRoutes from './payments.routes';
import customersRoutes from './customers.routes';
import adminRoutes from './admin.routes';
import ordersRoutes from './orders.routes';
import heldBillsRoutes from './held-bills.routes';
import returnsRoutes from './returns.routes';
import shiftsRoutes from './shifts.routes';
import dayCloseRoutes from './day-close.routes';
import inventoryLinkRoutes from './inventory-link.routes';
import reportsRoutes from './reports.routes';
import publicRoutes from './public.routes';
import devicesRoutes from './devices.routes';
import integrationRoutes from './integration.routes';
import connectionsRoutes from './connections.routes';
import authRoutes from './auth.routes';
import staffRoutes from './staff.routes';
import platformRoutes from './platform.routes';

/**
 * Everything mounts under /api/v1.
 *
 * The version is in the path from the first commit, before anyone outside has called anything. A
 * client's own software will integrate against these paths, and their integration must not break
 * when ours moves -- adding a version later means either breaking them or running an unversioned
 * path forever.
 */
const router = Router();

router.use('/health', healthRoutes);
router.use('/sales', salesRoutes);
router.use('/shop', shopRoutes);
router.use('/home', homeRoutes);
router.use('/bills', billsRoutes);
router.use('/items', itemsRoutes);
router.use('/payments', paymentsRoutes);
router.use('/customers', customersRoutes);
router.use('/admin', adminRoutes);
router.use('/orders', ordersRoutes);
router.use('/held-bills', heldBillsRoutes);
router.use('/returns', returnsRoutes);
router.use('/shifts', shiftsRoutes);
router.use('/day-close', dayCloseRoutes);
router.use('/inventory-link', inventoryLinkRoutes);
router.use('/reports', reportsRoutes);
router.use('/devices', devicesRoutes);
// The owner's Connections screen: API keys, webhooks, import, export. WF-INTEGRATIONS-01.
router.use('/connections', connectionsRoutes);
// A shop's own software, with an API key. POS-API-001..007.
router.use('/integration', integrationRoutes);
// Signing in at the till, the owner's staff list, and ScaleEzy's shop setup. Phase 13.
router.use('/auth', authRoutes);
router.use('/staff', staffRoutes);
router.use('/platform', platformRoutes);
// No sign-in: the digital receipt, reached by its token. POS-RCPT-009.
router.use('/public', publicRoutes);

export default router;
