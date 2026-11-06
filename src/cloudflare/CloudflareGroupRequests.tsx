import { Alert, Box, Button, Typography } from "@mui/material";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GroupJoinRequestInterface } from "@churchapps/helpers";
import { PendingJoinRequests } from "../groups/components/PendingJoinRequests";

/** Reuse the upstream review cards and decline dialog with the local request API. */
export function CloudflareGroupRequests({ groupId, onChanged }: { groupId?: string; onChanged?: () => void }) {
  const path = groupId ? `/groupjoinrequests/group/${groupId}` : "/groupjoinrequests/pending";
  const cache = useQueryClient();
  const query = useQuery<GroupJoinRequestInterface[]>({ queryKey: [path, "MembershipApi"], retry: false });
  const changed = async () => { await cache.invalidateQueries({ predicate: item => item.queryKey[1] === "MembershipApi" }); onChanged?.(); };
  return <Box><Typography variant="h2" sx={{ mb: 2 }}>Group join requests</Typography>
    {query.isError ? <Alert severity="error">Could not load requests. Group leader or Group Members edit permission is required.</Alert> : query.isLoading ? <Typography>Loading requests…</Typography> : query.data?.length ? <PendingJoinRequests requests={query.data} showGroupName={!groupId} onChanged={changed} /> : <Typography>No pending join requests.</Typography>}
    <Button onClick={() => query.refetch()} disabled={query.isFetching}>Refresh requests</Button>
  </Box>;
}
