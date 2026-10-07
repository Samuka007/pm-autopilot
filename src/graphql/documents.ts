/**
 * src/graphql/documents.ts — #4 codegen-typed GraphQL documents.
 *
 * Single source of truth for every static document the autopilot issues.
 * Bodies are the recorded request templates verbatim from
 * .github/workflows/project-board-sync.yml (known-good shapes); operation
 * names were added for deterministic generated type names. Codegen
 * (`pnpm codegen`) validates each document against GitHub's real schema —
 * the SDL shipped by @octokit/graphql-schema, parsed offline — and emits
 * `XQuery` / `XVariables` types into src/generated/graphql.ts, which this
 * module binds to each constant via `TypedDocumentNode` phantom types: a
 * plain `string` at runtime, so the transport seam (`GqlFn`) and the offline
 * test mocks are untouched. The `/* GraphQL *&#47;` leading comment is the
 * extractor marker graphql-codegen plucks these literals by; the wrapping
 * parentheses keep that comment attached to the template node (a bare
 * `as`-cast steals it).
 *
 * The one exception to codegen coverage is the dynamically composed aliased
 * verification batch in core.ts (`verifyQuery`): its alias set is only known
 * at runtime, so it cannot be enumerated for codegen and keeps its
 * hand-written `VerifyIssue` result interface.
 */

import type {
  AddBlockedByMutation,
  AddBlockedByMutationVariables,
  AddLabelsMutation,
  AddLabelsMutationVariables,
  AddProjectItemMutation,
  AddProjectItemMutationVariables,
  CloseIssueMutation,
  CloseIssueMutationVariables,
  CloseoutTicketQuery,
  CloseoutTicketQueryVariables,
  CreateIssueMutation,
  CreateIssueMutationVariables,
  DeleteProjectItemMutation,
  DeleteProjectItemMutationVariables,
  IssueNodeIdQuery,
  IssueNodeIdQueryVariables,
  ProjectFieldsQuery,
  ProjectFieldsQueryVariables,
  RepoLabelIdQuery,
  RepoLabelIdQueryVariables,
  RepoOpenMilestonesQuery,
  RepoOpenMilestonesQueryVariables,
  RepoVocabularyQuery,
  RepoVocabularyQueryVariables,
  SetMilestoneMutation,
  SetMilestoneMutationVariables,
  SetSingleSelectMutation,
  SetSingleSelectMutationVariables,
  SnapshotQuery,
  SnapshotQueryVariables,
} from "../generated/graphql.js";

/** Compile-time (document, variables, result) triple. The phantom fields
 *  exist only for the checker: the value erases to the bare query string the
 *  transport already speaks. */
export type TypedDocumentNode<TResult, TVariables> = string & {
  readonly __result?: TResult;
  readonly __variables?: TVariables;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Full board state: paginated project items + open issues. */
export const SnapshotDocument = (/* GraphQL */ `
  query Snapshot($id: ID!, $owner: String!, $repo: String!, $itemCursor: String, $issueCursor: String) {
    project: node(id: $id) { ... on ProjectV2 {
      items(first: 100, after: $itemCursor) { pageInfo { hasNextPage endCursor }
        nodes { id
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content { __typename ... on Issue {
            id number title state bodyText updatedAt
            closedAt
            milestone { title }
            labels(first: 50) { nodes { name } }
            blockedBy(first: 50) { nodes { number state title } }
          } }
        } } } }
    repository(owner: $owner, name: $repo) {
      issues(states: OPEN, first: 100, after: $issueCursor) { pageInfo { hasNextPage endCursor }
        nodes { id number title state bodyText updatedAt
          closedAt
          milestone { title }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state title } }
        } } }
  }
`) as TypedDocumentNode<SnapshotQuery, SnapshotQueryVariables>;

/** Runtime Status/Priority field + option-id resolution. */
export const ProjectFieldsDocument = (/* GraphQL */ `
  query ProjectFields($id: ID!) {
    node(id: $id) { ... on ProjectV2 {
      fields(first: 20) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
    } }
  }
`) as TypedDocumentNode<ProjectFieldsQuery, ProjectFieldsQueryVariables>;

/** #151 filing preflight: repository id + the FULL registered label
 *  vocabulary (paginated) + the open milestone title → { id, number } map —
 *  the number mapping is resolved at runtime, never hardcoded. */
export const RepoVocabularyDocument = (/* GraphQL */ `
  query RepoVocabulary($owner: String!, $repo: String!, $labelCursor: String) {
    repository(owner: $owner, name: $repo) {
      id
      labels(first: 100, after: $labelCursor) { pageInfo { hasNextPage endCursor }
        nodes { id name } }
      milestones(first: 50, states: OPEN) { nodes { id number title } }
    }
  }
`) as TypedDocumentNode<RepoVocabularyQuery, RepoVocabularyQueryVariables>;

/** The closeout gate's read primitive (#390): one ticket, from the board. */
export const CloseoutTicketDocument = (/* GraphQL */ `
  query CloseoutTicket($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { title bodyText labels(first: 50) { nodes { name } } }
    }
  }
`) as TypedDocumentNode<CloseoutTicketQuery, CloseoutTicketQueryVariables>;

/** Preflight label-name → node-id resolution (closed vocabulary). */
export const RepoLabelIdDocument = (/* GraphQL */ `
  query RepoLabelId($owner: String!, $repo: String!, $name: String!) {
    repository(owner: $owner, name: $repo) {
      label(name: $name) { id name }
    }
  }
`) as TypedDocumentNode<RepoLabelIdQuery, RepoLabelIdQueryVariables>;

/** Preflight milestone-title → node-id resolution (open milestones). */
export const RepoOpenMilestonesDocument = (/* GraphQL */ `
  query RepoOpenMilestones($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      milestones(first: 50, states: OPEN) { nodes { id title } }
    }
  }
`) as TypedDocumentNode<RepoOpenMilestonesQuery, RepoOpenMilestonesQueryVariables>;

/** Blocker node-id resolution: a dependency edge needs the target issue id. */
export const IssueNodeIdDocument = (/* GraphQL */ `
  query IssueNodeId($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { id }
    }
  }
`) as TypedDocumentNode<IssueNodeIdQuery, IssueNodeIdQueryVariables>;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const AddProjectItemDocument = (/* GraphQL */ `
  mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }
`) as TypedDocumentNode<AddProjectItemMutation, AddProjectItemMutationVariables>;

export const SetSingleSelectDocument = (/* GraphQL */ `
  mutation SetSingleSelect($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(input: {
      projectId: $projectId
      itemId: $itemId
      fieldId: $fieldId
      value: { singleSelectOptionId: $optionId }
    }) { projectV2Item { id } }
  }
`) as TypedDocumentNode<SetSingleSelectMutation, SetSingleSelectMutationVariables>;

export const SetMilestoneDocument = (/* GraphQL */ `
  mutation SetMilestone($id: ID!, $milestoneId: ID) {
    updateIssue(input: { id: $id, milestoneId: $milestoneId }) { issue { number } }
  }
`) as TypedDocumentNode<SetMilestoneMutation, SetMilestoneMutationVariables>;

export const AddBlockedByDocument = (/* GraphQL */ `
  mutation AddBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
    addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) { issue { number } }
  }
`) as TypedDocumentNode<AddBlockedByMutation, AddBlockedByMutationVariables>;

/** #151: creation carries no labels at all — labels land here, by
 *  pre-resolved id, so the REST auto-create path can never trigger
 *  (invariant 5). */
export const AddLabelsDocument = (/* GraphQL */ `
  mutation AddLabels($labelableId: ID!, $labelIds: [ID!]!) {
    addLabelsToLabelable(input: { labelableId: $labelableId, labelIds: $labelIds }) { labelable { ... on Issue { number } } }
  }
`) as TypedDocumentNode<AddLabelsMutation, AddLabelsMutationVariables>;

/** #151: issue creation is GraphQL-only (CreateIssueInput carries no labels
 *  — invariant 5, see AddLabelsDocument). */
export const CreateIssueDocument = (/* GraphQL */ `
  mutation CreateIssue($repositoryId: ID!, $title: String!, $body: String!, $milestoneId: ID) {
    createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body, milestoneId: $milestoneId }) { issue { id number url } }
  }
`) as TypedDocumentNode<CreateIssueMutation, CreateIssueMutationVariables>;

/** #151 rollback: remove the board item. */
export const DeleteProjectItemDocument = (/* GraphQL */ `
  mutation DeleteProjectItem($projectId: ID!, $itemId: ID!) {
    deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
  }
`) as TypedDocumentNode<DeleteProjectItemMutation, DeleteProjectItemMutationVariables>;

/** #151 rollback: close as not_planned. */
export const CloseIssueDocument = (/* GraphQL */ `
  mutation CloseIssue($issueId: ID!, $stateReason: IssueClosedStateReason!) {
    closeIssue(input: { issueId: $issueId, stateReason: $stateReason }) { issue { number state } }
  }
`) as TypedDocumentNode<CloseIssueMutation, CloseIssueMutationVariables>;
