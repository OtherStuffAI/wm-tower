const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const uuid = { type: 'string', format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };
const bool = { type: 'boolean' };
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const array = (items: unknown) => ({ type: 'array', items });
const body = (name: string) => ({ required: true, content: { 'application/json': { schema: ref(name) } } });
const response = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
const errors = Object.fromEntries(['400', '401', '403', '404', '409', '503'].map(code => [code, response('ErrorResponse', 'Learning request rejected')]));
const id = (name: string) => ({ name, in: 'path', required: true, schema: uuid });
const grant = { name: 'x-learning-grant-id', in: 'header', required: false, schema: uuid, description: 'Select an active grant held by the signed actor. Never supplies a learner identity.' };
const operation = (summary: string, result: string, method: 'get' | 'post', options: { input?: string; parameters?: unknown[]; created?: boolean; delegated?: boolean } = {}) => ({
  tags: ['Space Learning'], summary, security: [{ nip98: [] }],
  ...(options.parameters || options.delegated ? { parameters: [...(options.parameters ?? []), ...(options.delegated ? [grant] : [])] } : {}),
  ...(method === 'post' && options.input ? { requestBody: body(options.input) } : {}),
  responses: { [options.created ? '201' : '200']: response(result, summary), ...errors },
});

export const learningSchemas = {
  LearningConcept: obj({ id: str, title: str, explanation: str, objective: str, source: { type: 'string', format: 'uri' }, prerequisites: array(str) }),
  LearningEdge: obj({ from: str, to: str, type: { type: 'string', enum: ['prerequisite'] } }),
  LearningMilestone: obj({ id: str, title: str, prerequisites: array(str), objective: str }),
  LearningCurriculum: obj({ corpus: str, version: str, reviewedAt: { type: 'string', format: 'date' }, reviewStatus: { type: 'string', enum: ['reviewed'] }, concepts: array(ref('LearningConcept')), edges: array(ref('LearningEdge')) }),
  LearningTraversal: obj({ corpus: str, version: str, goal: str, order: array(ref('LearningMilestone')), cycles: array(array(str)), missing: array(str), valid: bool }),
  LearningProfileResponse: obj({ learnerNpub: str }),
  LearningDelegationRequest: obj({ granteeNpub: str, role: { type: 'string', enum: ['guardian', 'agent', 'reviewer'] }, canWrite: bool }),
  LearningDelegation: obj({ id: uuid, grantee_npub: str, role: str, can_read: bool, can_write: bool, created_at: dateTime }),
  LearningDelegationResponse: obj({ delegation: ref('LearningDelegation') }),
  LearningRevokeResponse: obj({ revoked: bool }),
  LearningPlanRequest: obj({ goal: str }),
  LearningPlan: obj({ id: uuid, learner_npub: str, goal: str, corpus: str, curriculum_version: str, milestones: array(ref('LearningMilestone')), created_at: dateTime }),
  LearningPlanResponse: obj({ plan: ref('LearningPlan') }),
  LearningLessonRequest: obj({ concept: str, frame: str }, ['concept']),
  LearningLesson: obj({ id: uuid, learner_npub: str, concept: str, corpus: str, curriculum_version: str, frame: { type: ['string', 'null'] }, content: str, created_at: dateTime }),
  LearningLessonResponse: obj({ lesson: ref('LearningLesson') }),
  LearningAttemptRequest: obj({ concept: str }),
  LearningAttempt: obj({ id: uuid, concept: str, kind: { type: 'string', enum: ['assessment', 'recall'] }, corpus: str, curriculum_version: str, prompt: str, issued_at: dateTime }),
  LearningAttemptResponse: obj({ attempt: ref('LearningAttempt') }),
  LearningSubmissionRequest: obj({ answer: str }),
  LearningEvidence: obj({ id: uuid, learner_npub: str, attempt_id: uuid, concept: str, kind: { type: 'string', enum: ['assessment', 'recall'] }, corpus: str, curriculum_version: str, answer: str, submitted_by_npub: str, independent: bool, passed: bool, score: str, rationale: { type: 'object' }, created_at: dateTime }),
  LearningSubmissionEvidence: obj({ id: uuid, concept: str, kind: str, independent: bool, passed: bool, score: str, rationale: { type: 'object' }, created_at: dateTime }),
  LearningMastery: obj({ concept: str, state: { type: 'string', enum: ['developing', 'demonstrated', 'remembered'] }, dueAt: { type: ['string', 'null'], format: 'date-time' }, due: bool, evidenceCount: { type: 'integer' } }),
  LearningSubmissionResponse: obj({ evidence: ref('LearningSubmissionEvidence'), mastery: { anyOf: [ref('LearningMastery'), { type: 'null' }] } }),
  LearningEvidenceList: obj({ evidence: array(ref('LearningEvidence')) }),
  LearningMasteryList: obj({ mastery: array(ref('LearningMastery')) }),
  LearningRecallDue: obj({ due: array(ref('LearningMastery')) }),
  LearningReviewRequest: obj({ approved: bool, rationale: str }),
  LearningReview: obj({ id: uuid, learner_npub: str, evidence_id: uuid, reviewer_npub: str, approved: bool, rationale: str, created_at: dateTime }),
  LearningReviewResponse: obj({ review: ref('LearningReview') }),
  ResearchSource: obj({ id: str, url: { type: 'string', format: 'uri' }, title: str, publisher: str, retrievedAt: { type: 'string', format: 'date' }, reviewedAt: { type: 'string', format: 'date' } }),
  ResearchConcept: obj({ id: str, cluster: str, title: str, claim: str }),
  ResearchRelation: obj({ id: str, from: str, to: str, type: { type: 'string', enum: ['prerequisite','supports','explains','related'] } }),
  ResearchSupport: obj({ targetType: { type: 'string', enum: ['concept','relation'] }, targetId: str, sourceId: str, locator: str, summary: str }),
  ResearchAddition: obj({ sources: array(ref('ResearchSource')), concepts: array(ref('ResearchConcept')), relations: array(ref('ResearchRelation')), supports: array(ref('ResearchSupport')) }),
  ResearchCandidate: obj({ id: str, corpus: str, base_version: str, content_hash: str, addition: ref('ResearchAddition'), status: { type: 'string', enum: ['staged','reviewed','published'] }, staged_by_npub: str, staged_at: dateTime, reviewed_by_npub: { type: ['string','null'] }, reviewed_at: { type: ['string','null'], format: 'date-time' }, published_version: { type: ['string','null'] } }),
  ResearchClusters: obj({ corpus: str, version: str, contentHash: str, reviewedAt: dateTime, clusters: array(obj({ id: str, conceptCount: { type: 'integer' } })), concepts: array(ref('ResearchConcept')) }),
  ResearchNeighbourhood: obj({ corpus: str, version: str, contentHash: str, reviewedAt: dateTime, center: str, concepts: array(ref('ResearchConcept')), relations: array(ref('ResearchRelation')) }),
  ResearchWalk: obj({ corpus: str, version: str, contentHash: str, reviewedAt: dateTime, start: str, depth: { type: 'integer' }, limit: { type: 'integer' }, truncated: bool, concepts: array(ref('ResearchConcept')), relations: array(ref('ResearchRelation')) }),
  ResearchProvenance: obj({ corpus: str, version: str, contentHash: str, reviewedAt: dateTime, concept: str, sources: array(ref('ResearchSource')), supports: array(ref('ResearchSupport')) }),
  ResearchCandidateRequest: obj({ id: str, baseVersion: str, addition: ref('ResearchAddition') }),
  ResearchCandidateResponse: obj({ candidate: ref('ResearchCandidate'), issues: array(str), idempotent: bool }),
  ResearchCandidateRead: obj({ candidate: ref('ResearchCandidate') }),
  ResearchReviewResponse: obj({ candidate: ref('ResearchCandidate'), mergedContentHash: str }),
  ResearchPublishRequest: obj({ version: str }),
  ResearchPublishResponse: obj({ corpus: str, version: str, contentHash: str, idempotent: bool }, ['corpus','version','idempotent']),
  LearningViewRequest: obj({ id: uuid, concept: str, kind: { type: 'string', enum: ['lesson','revision'] }, lessonId: uuid }, ['id','concept','kind']),
  LearningViewResponse: obj({ view: obj({ id: uuid, concept: str, kind: str, created_at: dateTime }), idempotent: bool }),
  LearningOverlayItem: obj({ concept: str, state: { type: 'string', enum: ['unseen','seen_once','seen_repeatedly','tested_provisional','demonstrated','remembered'] }, lessonViews: { type: 'integer' }, revisionViews: { type: 'integer' }, assessmentCount: { type: 'integer' }, recallCount: { type: 'integer' }, firstViewedAt: { type: ['string','null'], format: 'date-time' }, lastViewedAt: { type: ['string','null'], format: 'date-time' }, lastAssessmentAt: { type: ['string','null'], format: 'date-time' }, lastRecallAt: { type: ['string','null'], format: 'date-time' }, dueAt: { type: ['string','null'], format: 'date-time' }, due: bool }),
  LearningOverlay: obj({ corpus: str, version: str, concepts: array(ref('LearningOverlayItem')) }),
};

const researchVersion = { name: 'version', in: 'query', required: false, schema: str, description: 'Immutable published version; omitted uses latest.' };
const researchConceptId = { name: 'id', in: 'path', required: true, schema: str };
export const learningPaths = {
  '/api/v4/learning/curriculum': { get: operation('Read reviewed Space graph', 'LearningCurriculum', 'get') },
  '/api/v4/learning/curriculum/traverse': { get: operation('Walk prerequisites for a goal', 'LearningTraversal', 'get', { parameters: [{ name: 'goal', in: 'query', required: true, schema: str }] }) },
  '/api/v4/learning/research/subjects': { get: operation('List published Space clusters and concepts', 'ResearchClusters', 'get', { parameters: [researchVersion] }) },
  '/api/v4/learning/research/concepts/{id}/neighbourhood': { get: operation('Read one hop of a published concept', 'ResearchNeighbourhood', 'get', { parameters: [researchConceptId, researchVersion] }) },
  '/api/v4/learning/research/concepts/{id}/walk': { get: operation('Walk a published graph with depth 0–4 and limit 1–100', 'ResearchWalk', 'get', { parameters: [researchConceptId, researchVersion, { name: 'depth', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 4 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }] }) },
  '/api/v4/learning/research/concepts/{id}/sources': { get: operation('Inspect concept and incident relation source support', 'ResearchProvenance', 'get', { parameters: [researchConceptId, researchVersion] }) },
  '/api/v4/learning/research/candidates': { post: operation('Stage idempotent graph addition; requires LEARNING_CURATOR_NPUBS allowlist', 'ResearchCandidateResponse', 'post', { input: 'ResearchCandidateRequest', created: true }) },
  '/api/v4/learning/research/candidates/{id}': { get: operation('Inspect staged candidate as curator', 'ResearchCandidateRead', 'get', { parameters: [researchConceptId] }) },
  '/api/v4/learning/research/candidates/{id}/review': { post: operation('Independently review supported candidate as curator', 'ResearchReviewResponse', 'post', { parameters: [researchConceptId] }) },
  '/api/v4/learning/research/candidates/{id}/publish': { post: operation('Publish reviewed immutable graph version as curator', 'ResearchPublishResponse', 'post', { parameters: [researchConceptId], input: 'ResearchPublishRequest' }) },
  '/api/v4/learning/profile': { post: operation('Create own learner profile', 'LearningProfileResponse', 'post', { created: true }) },
  '/api/v4/learning/delegations': { post: operation('Grant a signed actor learner access', 'LearningDelegationResponse', 'post', { input: 'LearningDelegationRequest', created: true }) },
  '/api/v4/learning/delegations/{id}/revoke': { post: operation('Revoke own learner grant', 'LearningRevokeResponse', 'post', { parameters: [id('id')] }) },
  '/api/v4/learning/plans': { post: operation('Create a learner roadmap', 'LearningPlanResponse', 'post', { input: 'LearningPlanRequest', created: true, delegated: true }) },
  '/api/v4/learning/plans/current': { get: operation('Read current learner roadmap', 'LearningPlanResponse', 'get', { delegated: true }) },
  '/api/v4/learning/lessons': { post: operation('Create a learner lesson', 'LearningLessonResponse', 'post', { input: 'LearningLessonRequest', created: true, delegated: true }) },
  '/api/v4/learning/lessons/{id}': { get: operation('Read a learner lesson', 'LearningLessonResponse', 'get', { parameters: [id('id')], delegated: true }) },
  '/api/v4/learning/assessments': { post: operation('Issue independent assessment', 'LearningAttemptResponse', 'post', { input: 'LearningAttemptRequest', created: true, delegated: true }) },
  '/api/v4/learning/assessments/{id}/submissions': { post: operation('Submit assessment answer', 'LearningSubmissionResponse', 'post', { input: 'LearningSubmissionRequest', parameters: [id('id')], created: true, delegated: true }) },
  '/api/v4/learning/evidence': { get: operation('Read learner evidence', 'LearningEvidenceList', 'get', { delegated: true }) },
  '/api/v4/learning/evidence/{id}/reviews': { post: operation('Review evidence as an independent granted actor', 'LearningReviewResponse', 'post', { input: 'LearningReviewRequest', parameters: [id('id'), { ...grant, required: true }], created: true }) },
  '/api/v4/learning/mastery': { get: operation('Read learner mastery', 'LearningMasteryList', 'get', { delegated: true }) },
  '/api/v4/learning/views': { post: operation('Record actual lesson or revision view for signed learner', 'LearningViewResponse', 'post', { input: 'LearningViewRequest', created: true, delegated: true }) },
  '/api/v4/learning/overlay': { get: operation('Read private learner counts and evidence states for published graph', 'LearningOverlay', 'get', { delegated: true, parameters: [researchVersion] }) },
  '/api/v4/learning/recall/due': { get: operation('Read due delayed recall', 'LearningRecallDue', 'get', { delegated: true }) },
  '/api/v4/learning/recall': { post: operation('Issue due recall', 'LearningAttemptResponse', 'post', { input: 'LearningAttemptRequest', created: true, delegated: true }) },
  '/api/v4/learning/recall/{id}/submissions': { post: operation('Submit recall answer', 'LearningSubmissionResponse', 'post', { input: 'LearningSubmissionRequest', parameters: [id('id')], created: true, delegated: true }) },
};
