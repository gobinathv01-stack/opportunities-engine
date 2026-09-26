export type OpportunityStatus = 'open' | 'won' | 'lost' | 'abandoned';

export interface Opportunity {
  id: string;
  workspace_id: string;
  stage: string;
  name: string;
  value: number;
  status: OpportunityStatus;
  owner_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}
