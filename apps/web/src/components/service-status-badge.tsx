import type { ServiceStatus } from '@proofserve/shared';

export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  const labels: Record<ServiceStatus, string> = {
    ACTIVE: 'Active',
    DRAFT: 'Draft',
    SUSPENDED: 'Suspended',
  };
  return <span className="badge">Service: {labels[status]}</span>;
}
