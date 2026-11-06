import React from "react";

export interface MemberChurchChoice {
  id: string;
  name: string;
}

interface Props {
  churches: MemberChurchChoice[];
  currentChurchId?: string;
  busy: boolean;
  onChoose: (churchId: string) => void;
  onCancel: () => void;
}

/** Only church labels reach the selector; session credentials remain in its host. */
export const MemberChurchSelector = ({ churches, currentChurchId = "", busy, onChoose, onCancel }: Props) => {
  const [selectedId, setSelectedId] = React.useState(currentChurchId);
  return <section className="mp-card mp-profile" aria-labelledby="member-church-heading">
    <h1 id="member-church-heading">Choose your church</h1>
    <p className="mp-muted">Open the community you want to view. Your profile and household belong to the selected church.</p>
    <form onSubmit={event => { event.preventDefault(); if (selectedId && !busy) onChoose(selectedId); }}>
      <label>Church<select value={selectedId} onChange={event => setSelectedId(event.target.value)} required disabled={busy}>
        <option value="" disabled>Select a church</option>
        {churches.map(church => <option key={church.id} value={church.id}>{church.name}</option>)}
      </select></label>
      <div className="mp-button-row">
        <button className="mp-primary" disabled={busy || !selectedId}>{busy ? "Opening church…" : "Open church"}</button>
        <button className="mp-quiet" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  </section>;
};
