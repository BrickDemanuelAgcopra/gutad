'use client';
import { ComplianceView } from '@/components/chef-ops';

export default function ChefCompliancePage() {
  return (
    <div className="space-y-4">
      <div><h1 className="text-2xl font-bold">Documents & quality</h1><p className="text-sm text-ink-600">Keep your kitchen documents current and see how Gutad measures quality.</p></div>
      <ComplianceView />
    </div>
  );
}
