import React, { useState, useCallback } from "react";
import { RoleCheck } from "./";
import { ApiHelper, type PermissionInterface, Locale } from "@churchapps/apphelper";
import { type RoleInterface, type RolePermissionInterface } from "@churchapps/helpers";
import { Accordion, AccordionSummary, AccordionDetails, Typography, Icon, TextField, MenuItem, Alert } from "@mui/material";
import { SettingsPanel } from "./SettingsPanel";

interface PermissionScope {
  id: string;
  name: string;
  permissions: { apiName: string; contentType: string }[];
}

interface Props {
  role: RoleInterface;
}

export const RolePermissions: React.FC<Props> = (props) => {
  const [rolePermissions, setRolePermissions] = useState<RolePermissionInterface[]>([]);
  const [permissions, setPermissions] = useState<PermissionInterface[]>([]);
  const [groups, setGroups] = useState<PermissionScope[]>([]);
  const [scope, setScope] = useState("");
  const [scopeError, setScopeError] = useState("");
  const cloudflare = process.env.REACT_APP_STAGE === "cloudflare";

  const [expanded, setExpanded] = React.useState<string | false>(false);
  const [filter, setFilter] = useState("");

  const search = filter.trim().toLowerCase();
  const selectedScope = groups.find(group => group.id === scope);
  const scopeKinds = selectedScope?.permissions || rolePermissions.filter(grant => grant.contentId === scope).map(grant => ({ apiName: grant.apiName, contentType: grant.contentType }));
  const scopedPermissions = scope ? permissions.filter(permission => scopeKinds.some(kind => kind.apiName === permission.apiName && kind.contentType === permission.section)) : permissions;
  const visible = search
    ? scopedPermissions.filter((p) => `${p.displayAction || ""} ${p.displaySection || ""} ${p.section || ""}`.toLowerCase().includes(search))
    : scopedPermissions;

  const handleChange = (panel: string) => (_event: React.SyntheticEvent, isExpanded: boolean) => {
    setExpanded(isExpanded ? panel : false);
  };

  const loadData = useCallback(() => {
    ApiHelper.get("/rolepermissions/roles/" + (props.role.id ?? "null"), "MembershipApi").then((data: any) => setRolePermissions(data));
  }, [props.role]);
  const handlePermissionChange = useCallback((rp: RolePermissionInterface, checked: boolean) => {
    setRolePermissions((prev) => {
      const rest = prev.filter((p) => !(p.apiName === rp.apiName && p.contentType === rp.contentType && p.action === rp.action && (p.contentId || "") === (rp.contentId || "")));
      return checked ? [...rest, rp] : rest;
    });
  }, []);
  const loadPermissions = useCallback(() => {
    ApiHelper.get("/permissions", "MembershipApi").then((data: any) => setPermissions(data));
  }, []);

  const isChecked = (p: PermissionInterface) => rolePermissions.some((rp) => rp.apiName === p.apiName && rp.contentType === p.section && rp.action === p.action && (rp.contentId || "") === scope);

  const getSectionCount = (displaySection: string) => {
    const inSection = scopedPermissions.filter((p) => p.displaySection === displaySection);
    return Locale.label("settings.rolePermissions.countOf")
      .replace("{checked}", inSection.filter(isChecked).length.toString())
      .replace("{total}", inSection.length.toString());
  };

  const getSections = () => {
    const lastSection: string[] = [];
    const result: JSX.Element[] = [];
    const sortedPermissions = [...visible].sort((a, b) => ((a.displaySection || "") > (b.displaySection || "") ? 1 : -1));

    sortedPermissions.forEach((p, index) => {
      if (!lastSection.includes(p.displaySection || "")) {
        result.push(
          <Accordion key={p.displaySection || index} expanded={!!search || !!scope || expanded === "panel" + index} onChange={handleChange("panel" + index)}>
            <AccordionSummary expandIcon={<Icon>expand_more</Icon>}>
              <Typography sx={{ flexGrow: 1 }}>{p.displaySection}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }} data-testid="role-permission-section-count">{getSectionCount(p.displaySection || "")}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <div>{getChecks(p.displaySection || "")}</div>
            </AccordionDetails>
          </Accordion>
        );
        lastSection.push(p.displaySection || "");
      }
    });
    return result;
  };

  const getChecks = (displaySection: string) => {
    const result: JSX.Element[] = [];
    visible.forEach((p, index) => {
      if (p.displaySection === displaySection) {
        result.push(<RoleCheck key={`${scope}:${index}`} roleId={props.role.id} rolePermissions={rolePermissions} apiName={p.apiName || ""} contentType={p.section || ""} contentId={scope || undefined} action={p.action || ""} label={p.displayAction || ""} onChange={handlePermissionChange} />);
      }
    });
    return result;
  };

  React.useEffect(() => {
    if (props.role?.name) loadData();
  }, [props.role, loadData]);
  React.useEffect(() => {
    if (props.role?.name) loadPermissions();
  }, [props.role, loadPermissions]);
  React.useEffect(() => {
    if (!cloudflare) return;
    let active = true;
    ApiHelper.get("/permissionScopes", "MembershipApi").then((data: PermissionScope[]) => { if (active) setGroups(data); }).catch(() => { if (active) setScopeError("Permission scopes could not be loaded. Global permissions remain available."); });
    return () => { active = false; };
  }, [cloudflare]);

  return (
    <SettingsPanel id="rolePermissionsBox" headerText={Locale.label("settings.rolePermissions.permEdit")} headerIcon="lock" help="docs/b1-admin/settings/roles-permissions">
      {cloudflare && <><TextField select fullWidth size="small" label="Permission scope" value={scope} onChange={event => { setScope(event.target.value); setFilter(""); }} data-testid="role-permission-scope" sx={{ mb: 2 }}>
        <MenuItem value="">All groups and church resources</MenuItem>
        {groups.map(group => <MenuItem value={group.id} key={group.id}>{group.name}</MenuItem>)}
        {rolePermissions.filter(grant => grant.contentId && !groups.some(group => group.id === grant.contentId)).filter((grant, index, array) => array.findIndex(item => item.contentId === grant.contentId) === index).map(grant => <MenuItem value={grant.contentId} key={grant.contentId}>Unavailable scope ({grant.contentId})</MenuItem>)}
      </TextField><Typography variant="body2" sx={{ mb: 2 }}>{scope ? "Group permissions cover this group, Plans cover this ministry, and Tasks cover work assigned to this group. Existing global grants still apply." : "These permissions apply across the church. Choose a group or ministry to manage its available scoped permissions."}</Typography>{scopeError && <Alert severity="warning">{scopeError}</Alert>}</>}
      <TextField
        fullWidth
        size="small"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        label={Locale.label("settings.rolePermissions.filter")}
        data-testid="role-permission-filter"
      />
      <div style={{ marginTop: 16 }}>{getSections()}</div>
    </SettingsPanel>
  );
};
