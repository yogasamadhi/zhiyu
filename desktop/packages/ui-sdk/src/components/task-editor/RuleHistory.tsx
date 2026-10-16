import type { RuleRecord, RuleRepairProposal, RuleVersionRecord } from '@zhiyun/contracts';
import { useState } from 'react';
import { productCopy } from '../../product-copy.js';
import { Badge, Button, Card } from '../ui.js';

export type RuleHistoryDiff = Array<{ path: string; before: unknown; after: unknown }>;

interface RuleHistoryProps {
  rules: Array<RuleRecord & { versions: RuleVersionRecord[] }>;
  versionDiff: RuleHistoryDiff;
  repairProposals: RuleRepairProposal[];
  repairDiff: RuleHistoryDiff;
  working: boolean;
  testedProposalId: string | null;
  activeDefinition: unknown;
  compareVersions(ruleId: string, from: number, to: number): Promise<void>;
  rollbackVersion(ruleId: string, version: number): Promise<void>;
  requestRepair(ruleId: string, failure: string): Promise<void>;
  testRepair(proposal: RuleRepairProposal): Promise<void>;
  reviewRepair(proposal: RuleRepairProposal, action: 'apply' | 'reject'): Promise<void>;
  onShowRepairDiff(diff: RuleHistoryDiff): void;
}

export function RuleHistory({
  rules,
  versionDiff,
  repairProposals,
  repairDiff,
  working,
  testedProposalId,
  activeDefinition,
  compareVersions,
  rollbackVersion,
  requestRepair,
  testRepair,
  reviewRepair,
  onShowRepairDiff,
}: RuleHistoryProps) {
  const [repairRequest, setRepairRequest] = useState<{
    ruleId: string;
    failure: string;
  } | null>(null);
  return (
    <>
      {rules.map((rule) => (
        <Card key={rule.id}>
          <div className="section-heading">
            <div>
              <h2>
                {productCopy('RuleVersion 历史 ·')}
                {rule.name}
              </h2>
              <p>{productCopy('版本不可变；回滚与修复都会创建新版本')}</p>
            </div>
            <Button
              className="button-secondary"
              disabled={working}
              onClick={() =>
                setRepairRequest({
                  ruleId: rule.id,
                  failure: productCopy('页面结构变化，当前规则提取不到数据'),
                })
              }
            >
              {productCopy('AI 修复建议')}
            </Button>
          </div>
          {repairRequest?.ruleId === rule.id && (
            <form
              className="form-grid"
              onSubmit={(event) => {
                event.preventDefault();
                const failure = repairRequest.failure.trim();
                if (!failure || working) return;
                void requestRepair(rule.id, failure).then(() => setRepairRequest(null));
              }}
            >
              <label className="full">
                <span>{productCopy('规则失败现象')}</span>
                <textarea
                  aria-label={productCopy('规则失败现象')}
                  rows={3}
                  value={repairRequest.failure}
                  onChange={(event) =>
                    setRepairRequest({ ruleId: rule.id, failure: event.target.value })
                  }
                />
              </label>
              <div className="row-actions">
                <Button type="submit" disabled={working || !repairRequest.failure.trim()}>
                  {productCopy('生成修复建议')}
                </Button>
                <Button
                  className="button-secondary"
                  disabled={working}
                  onClick={() => setRepairRequest(null)}
                >
                  {productCopy('取消')}
                </Button>
              </div>
            </form>
          )}
          <div className="version-list">
            {rule.versions.map((version, index) => (
              <div className="version-item" key={version.id}>
                <div>
                  <strong>v{version.version}</strong>
                  <small>
                    {version.generatedBy} · {new Date(version.createdAt).toLocaleString()}
                  </small>
                </div>
                <div className="row-actions">
                  {index < rule.versions.length - 1 && (
                    <Button
                      className="button-secondary"
                      onClick={() =>
                        void compareVersions(
                          rule.id,
                          rule.versions[index + 1]!.version,
                          version.version,
                        )
                      }
                    >
                      {productCopy('比较版本')}
                    </Button>
                  )}
                  {rule.activeVersionId !== version.id && (
                    <Button
                      className="button-secondary"
                      onClick={() => void rollbackVersion(rule.id, version.version)}
                    >
                      {productCopy('回滚到此版本')}
                    </Button>
                  )}
                  {rule.activeVersionId === version.id && (
                    <Badge tone="success">{productCopy('使用中')}</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
          {versionDiff.length > 0 && (
            <pre className="diff-view">
              {versionDiff
                .map(
                  (change) =>
                    `${change.path}\n- ${JSON.stringify(change.before)}\n+ ${JSON.stringify(change.after)}`,
                )
                .join('\n\n')}
            </pre>
          )}
          {repairProposals.filter((proposal) => proposal.ruleId === rule.id).length > 0 && (
            <div className="repair-list">
              <h3>{productCopy('修复建议')}</h3>
              {repairProposals
                .filter((proposal) => proposal.ruleId === rule.id)
                .map((proposal) => (
                  <div className="version-item" key={proposal.id}>
                    <div>
                      <Badge
                        tone={
                          proposal.status === 'applied'
                            ? 'success'
                            : proposal.status === 'rejected'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {proposal.status}
                      </Badge>
                      <strong>{proposal.explanation}</strong>
                      <small>{new Date(proposal.createdAt).toLocaleString()}</small>
                    </div>
                    {proposal.status === 'pending' && (
                      <div className="row-actions">
                        <Button
                          className="button-secondary"
                          onClick={() => {
                            onShowRepairDiff(
                              definitionDiffForUi(activeDefinition, proposal.definition),
                            );
                          }}
                        >
                          {productCopy('查看 Diff')}
                        </Button>
                        <Button
                          className="button-secondary"
                          onClick={() => void testRepair(proposal)}
                        >
                          {productCopy('测试')}
                        </Button>
                        <Button
                          disabled={testedProposalId !== proposal.id}
                          onClick={() => void reviewRepair(proposal, 'apply')}
                        >
                          {productCopy('确认应用')}
                        </Button>
                        <Button
                          className="button-danger"
                          onClick={() => void reviewRepair(proposal, 'reject')}
                        >
                          {productCopy('拒绝')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              {repairDiff.length > 0 && (
                <pre className="diff-view">
                  {repairDiff
                    .map(
                      (change) =>
                        `${change.path}\n- ${JSON.stringify(change.before)}\n+ ${JSON.stringify(change.after)}`,
                    )
                    .join('\n\n')}
                </pre>
              )}
            </div>
          )}
        </Card>
      ))}
    </>
  );
}

function definitionDiffForUi(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      definitionDiffForUi(left[key], right[key], `${path}/${key}`),
    );
  }
  return [{ path: path || '/', before, after }];
}
