import React from "react";
import { memberErrorMessage, memberRequest, memberSessionExpired } from "./memberApi";
import type { MemberProfile, MemberProfileChanges } from "./memberProfileTypes";

interface Props {
  profile: MemberProfile;
  token: string;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSaved: (profile: MemberProfile) => void;
  onExpired: () => void;
}

function values(profile: MemberProfile) {
  const person = profile.person;
  return {
    firstName: person.name.first || "",
    middleName: person.name.middle || "",
    lastName: person.name.last || "",
    nickName: person.name.nick || "",
    mobilePhone: person.contactInfo.mobilePhone || "",
    homePhone: person.contactInfo.homePhone || "",
    address1: person.contactInfo.address1 || "",
    address2: person.contactInfo.address2 || "",
    city: person.contactInfo.city || "",
    state: person.contactInfo.state || "",
    zip: person.contactInfo.zip || "",
    birthDate: person.birthDate || ""
  };
}

export const MemberProfileEditor = ({ profile, token, disabled, onBusy, onSaved, onExpired }: Props) => {
  const [draft, setDraft] = React.useState(() => values(profile));
  const [directoryVisible, setDirectoryVisible] = React.useState(profile.person.directoryVisible);
  const [shareEmail, setShareEmail] = React.useState(profile.person.shareEmail);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const direct = profile.settings.profileEditMode === "direct";
  React.useEffect(() => {
    setDraft(values(profile)); setDirectoryVisible(profile.person.directoryVisible); setShareEmail(profile.person.shareEmail);
  }, [profile]);

  async function save(changes: MemberProfileChanges, message: string) {
    if (saving || disabled) return;
    setSaving(true); onBusy(true); setError(""); setNotice("");
    try {
      const result = await memberRequest<MemberProfile>("/api/member/v1/me", token, { method: "POST", body: JSON.stringify(changes) });
      onSaved(result); setNotice(message);
    } catch (problem) { if (memberSessionExpired(problem)) onExpired(); setError(memberErrorMessage(problem)); } finally { setSaving(false); onBusy(false); }
  }

  function input(field: keyof typeof draft, label: string, options: { type?: string; autoComplete?: string; maxLength?: number; required?: boolean } = {}) {
    return <label>{label}<input value={draft[field]} onChange={event => setDraft(previous => ({ ...previous, [field]: event.target.value }))}
      type={options.type || "text"} autoComplete={options.autoComplete} maxLength={options.maxLength || (field.endsWith("Name") ? 100 : 200)} max={field === "birthDate" ? new Date().toISOString().slice(0, 10) : undefined} required={options.required} /></label>;
  }

  return <section aria-label="Your profile details">
    {error && <p className="mp-alert" role="alert">{error}</p>}
    {notice && <p className="mp-notice" role="status">{notice}</p>}
    <form className="mp-card mp-profile" onSubmit={event => { event.preventDefault(); if (direct) save({ ...draft, birthDate: draft.birthDate || null }, "Your profile has been saved."); }}>
      <h2>{profile.person.name.display}</h2>
      <p className="mp-muted">{profile.person.contactInfo.email}</p>
      {!direct && <p className="mp-notice">Your church requires staff review for profile and household changes. Contact your church office to update these details.</p>}
      <fieldset disabled={disabled || saving || !direct} className="mp-profile-fields">
        <legend>Personal details</legend>
        <div className="mp-grid">
          {input("firstName", "First name", { autoComplete: "given-name", required: true })}
          {input("middleName", "Middle name", { autoComplete: "additional-name" })}
          {input("lastName", "Last name", { autoComplete: "family-name", required: true })}
          {input("nickName", "Preferred name", { autoComplete: "nickname" })}
          {input("birthDate", "Birth date", { type: "date", autoComplete: "bday" })}
        </div>
      </fieldset>
      <fieldset disabled={disabled || saving || !direct} className="mp-profile-fields">
        <legend>Contact details</legend>
        <div className="mp-grid">
          {input("mobilePhone", "Mobile phone", { type: "tel", autoComplete: "tel", maxLength: 40 })}
          {input("homePhone", "Home phone", { type: "tel", maxLength: 40 })}
        </div>
        {input("address1", "Address line 1", { autoComplete: "address-line1" })}
        {input("address2", "Address line 2", { autoComplete: "address-line2" })}
        <div className="mp-grid">
          {input("city", "City", { autoComplete: "address-level2" })}
          {input("state", "State or region", { autoComplete: "address-level1" })}
          {input("zip", "Postal code", { autoComplete: "postal-code" })}
        </div>
      </fieldset>
      <p className="mp-muted">These details update your record at {profile.church.name}. Your sign-in email and other household members’ records are managed separately.</p>
      {direct && <button className="mp-primary" disabled={disabled || saving}>{saving ? "Saving…" : "Save profile"}</button>}
    </form>
    <form className="mp-card mp-profile" onSubmit={event => { event.preventDefault(); save({ directoryVisible, shareEmail }, "Your directory preferences have been saved."); }}>
      <h2>Directory preferences</h2>
      <fieldset disabled={disabled || saving}>
        <legend>Choose what members can see</legend>
        <label className="mp-checkbox"><input type="checkbox" checked={directoryVisible} onChange={event => setDirectoryVisible(event.target.checked)} />Show my name in the member directory</label>
        <label className="mp-checkbox"><input type="checkbox" checked={shareEmail} onChange={event => setShareEmail(event.target.checked)} />Share my email with signed-in members</label>
        <p className="mp-muted">Your email is shown only when both preferences are enabled. Your address, birth date and phone numbers are not included in the member directory.</p>
      </fieldset>
      <button className="mp-primary" disabled={disabled || saving}>{saving ? "Saving…" : "Save preferences"}</button>
    </form>
  </section>;
};
