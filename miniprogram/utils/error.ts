/**
 * 统一错误处理（向后兼容导出）
 * 真正的实现见 utils/toast.ts，本文件仅保留同名导出。
 */
export { toAppError, showError, showInfo, showSuccess, showWarn, showBusinessError } from './toast';
export type { AppError, ErrorCategory } from './toast';