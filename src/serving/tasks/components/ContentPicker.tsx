import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Paper } from "@mui/material";
import React from "react";
import { SelectGroup } from ".";
import { Locale, PersonHelper, UserHelper, Permissions, type PersonInterface } from "@churchapps/apphelper";
import { type GroupInterface } from "@churchapps/helpers";
import { PersonAdd } from "../../../components";
import { Person as PersonIcon, Group as GroupIcon, Close as CloseIcon } from "@mui/icons-material";
import { canEditTask } from "../permissions";
import { SmartTabs } from "../../../components/ui";

interface Props {
  onClose: () => void;
  onSelect: (contentType: string, contentId: string, label: string) => void;
  /** Offer a "No person or group" choice; it calls onSelect with empty values. */
  allowNone?: boolean;
  assignment?: boolean;
}

export const ContentPicker: React.FC<Props> = (props) => {
  const allowPerson = process.env.REACT_APP_STAGE !== "cloudflare" || ((UserHelper.checkAccess(Permissions.membershipApi.people.view) || UserHelper.checkAccess(Permissions.membershipApi.people.edit)) && (!props.assignment || canEditTask()));
  const [activeKey, setActiveKey] = React.useState(allowPerson ? "person" : "group");
  const handlePersonAdd = (p: PersonInterface) => {
    props.onSelect("person", p?.id || "", p?.name?.display || Locale.label("person.unknown"));
  };
  const handleGroupAdd = (g: GroupInterface) => {
    props.onSelect("group", g.id || "", g.name || "");
  };

  const tabs = [
    {
      key: "person",
      label: (
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <PersonIcon fontSize="small" /> {Locale.label("tasks.contentPicker.pers")}
        </Box>
      ),
      content: (
        <Box sx={{ pt: 2 }}>
          <PersonAdd getPhotoUrl={PersonHelper.getPhotoUrl} addFunction={handlePersonAdd} actionLabel={Locale.label("tasks.contentPicker.sel")} />
        </Box>
      )
    },
    {
      key: "group",
      label: (
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
          <GroupIcon fontSize="small" /> {Locale.label("tasks.contentPicker.group")}
        </Box>
      ),
      content: (
        <Box sx={{ pt: 2 }}>
          <SelectGroup addFunction={handleGroupAdd} editOnly={props.assignment} />
        </Box>
      )
    }
  ].filter(tab => tab.key !== "person" || allowPerson);

  return (
    <Dialog open={true} onClose={props.onClose} maxWidth="sm" fullWidth>
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          pb: 2
        }}>
        {Locale.label("tasks.contentPicker.selPers")}
      </DialogTitle>
      <DialogContent sx={{ pt: 0 }}>
        <Paper variant="outlined" sx={{ overflow: "hidden", p: 2 }}>
          <SmartTabs tabs={tabs} value={activeKey} onChange={(k) => setActiveKey(k)} ariaLabel="content-picker-tabs" />
          {/* <Box sx={{ minHeight: 400 }} /> */}
        </Paper>
      </DialogContent>
      <DialogActions sx={{ p: 2, pt: 0, justifyContent: props.allowNone ? "space-between" : "flex-end" }}>
        {props.allowNone && (
          <Button variant="text" onClick={() => props.onSelect("", "", "")} data-testid="content-picker-none">
            {Locale.label("tasks.contentPicker.none", "No person or group")}
          </Button>
        )}
        <Button
          variant="outlined"
          onClick={props.onClose}
          startIcon={<CloseIcon />}>
          {Locale.label("common.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};
