/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type * as Types from './graphql-schema';

export type SnapshotQueryVariables = Exact<{
  id: string | number;
  owner: string;
  repo: string;
  itemCursor?: string | null | undefined;
  issueCursor?: string | null | undefined;
}>;


export type SnapshotQuery = { project:
    | { items: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, status:
            | { name: string | null }
            | Record<PropertyKey, never>
           | null, priority:
            | { name: string | null }
            | Record<PropertyKey, never>
           | null, content:
            | { __typename: 'DraftIssue' }
            | { __typename: 'Issue', id: string, number: number, title: string, state: Types.IssueState, bodyText: string, updatedAt: string, closedAt: string | null, milestone: { title: string } | null, labels: { nodes: Array<{ name: string } | null> | null } | null, blockedBy: { nodes: Array<{ number: number, state: Types.IssueState, title: string } | null> | null } }
            | { __typename: 'PullRequest' }
           | null } | null> | null } }
    | Record<PropertyKey, never>
   | null, repository: { issues: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, number: number, title: string, state: Types.IssueState, bodyText: string, updatedAt: string, closedAt: string | null, milestone: { title: string } | null, labels: { nodes: Array<{ name: string } | null> | null } | null, blockedBy: { nodes: Array<{ number: number, state: Types.IssueState, title: string } | null> | null } } | null> | null } } | null };

export type ProjectFieldsQueryVariables = Exact<{
  id: string | number;
}>;


export type ProjectFieldsQuery = { node:
    | { fields: { nodes: Array<
          | { id: string, name: string, options: Array<{ id: string, name: string }> }
          | Record<PropertyKey, never>
         | null> | null } }
    | Record<PropertyKey, never>
   | null };

export type RepoVocabularyQueryVariables = Exact<{
  owner: string;
  repo: string;
  labelCursor?: string | null | undefined;
}>;


export type RepoVocabularyQuery = { repository: { id: string, labels: { pageInfo: { hasNextPage: boolean, endCursor: string | null }, nodes: Array<{ id: string, name: string } | null> | null } | null, milestones: { nodes: Array<{ id: string, number: number, title: string } | null> | null } | null } | null };

export type CloseoutTicketQueryVariables = Exact<{
  owner: string;
  repo: string;
  number: number;
}>;


export type CloseoutTicketQuery = { repository: { issue: { title: string, bodyText: string, labels: { nodes: Array<{ name: string } | null> | null } | null } | null } | null };

export type RepoLabelIdQueryVariables = Exact<{
  owner: string;
  repo: string;
  name: string;
}>;


export type RepoLabelIdQuery = { repository: { label: { id: string, name: string } | null } | null };

export type RepoOpenMilestonesQueryVariables = Exact<{
  owner: string;
  repo: string;
}>;


export type RepoOpenMilestonesQuery = { repository: { milestones: { nodes: Array<{ id: string, title: string } | null> | null } | null } | null };

export type IssueNodeIdQueryVariables = Exact<{
  owner: string;
  repo: string;
  number: number;
}>;


export type IssueNodeIdQuery = { repository: { issue: { id: string } | null } | null };

export type AddProjectItemMutationVariables = Exact<{
  projectId: string | number;
  contentId: string | number;
}>;


export type AddProjectItemMutation = { addProjectV2ItemById: { item: { id: string } | null } | null };

export type SetSingleSelectMutationVariables = Exact<{
  projectId: string | number;
  itemId: string | number;
  fieldId: string | number;
  optionId: string;
}>;


export type SetSingleSelectMutation = { updateProjectV2ItemFieldValue: { projectV2Item: { id: string } | null } | null };

export type SetMilestoneMutationVariables = Exact<{
  id: string | number;
  milestoneId?: string | number | null | undefined;
}>;


export type SetMilestoneMutation = { updateIssue: { issue: { number: number } | null } | null };

export type AddBlockedByMutationVariables = Exact<{
  issueId: string | number;
  blockingIssueId: string | number;
}>;


export type AddBlockedByMutation = { addBlockedBy: { issue: { number: number } | null } | null };

export type AddLabelsMutationVariables = Exact<{
  labelableId: string | number;
  labelIds: Array<string | number> | string | number;
}>;


export type AddLabelsMutation = { addLabelsToLabelable: { labelable:
      | { number: number }
      | Record<PropertyKey, never>
     | null } | null };

export type CreateIssueMutationVariables = Exact<{
  repositoryId: string | number;
  title: string;
  body: string;
  milestoneId?: string | number | null | undefined;
}>;


export type CreateIssueMutation = { createIssue: { issue: { id: string, number: number, url: string } | null } | null };

export type DeleteProjectItemMutationVariables = Exact<{
  projectId: string | number;
  itemId: string | number;
}>;


export type DeleteProjectItemMutation = { deleteProjectV2Item: { deletedItemId: string | null } | null };

export type CloseIssueMutationVariables = Exact<{
  issueId: string | number;
  stateReason: Types.IssueClosedStateReason;
}>;


export type CloseIssueMutation = { closeIssue: { issue: { number: number, state: Types.IssueState } | null } | null };
