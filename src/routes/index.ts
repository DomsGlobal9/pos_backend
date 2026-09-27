import { Router } from 'express';
import healthRoutes from './health.routes';
import salesRoutes from './sales.routes';
import shopRoutes from './shop.routes';
import homeRoutes from './home.routes';

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

export default router;
