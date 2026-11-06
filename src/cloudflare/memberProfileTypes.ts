export interface MemberName {
  first: string;
  last: string;
  middle?: string;
  nick?: string;
  display: string;
}

export interface MemberProfile {
  person: {
    id: string;
    name: MemberName;
    contactInfo: {
      email: string | null;
      mobilePhone?: string;
      homePhone?: string;
      address1?: string;
      address2?: string;
      city?: string;
      state?: string;
      zip?: string;
    };
    birthDate?: string | null;
    householdId?: string | null;
    householdRole?: string | null;
    directoryVisible: boolean;
    shareEmail: boolean;
  };
  church: { id: string; name: string; subDomain: string };
  settings: { profileEditMode: "direct" | "review"; familyAddEnabled: boolean; familyEditMode: "review" | "unavailable" };
}

export interface MemberProfileChanges {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  nickName?: string;
  mobilePhone?: string;
  homePhone?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  birthDate?: string | null;
  directoryVisible?: boolean;
  shareEmail?: boolean;
}

export interface MemberHouseholdData {
  household: { id: string; name: string } | null;
  members: { id: string; name: MemberName; householdRole: string | null; isSelf: boolean }[];
  canAdd: boolean;
}

export interface MemberChurchLink {
  church: { id: string; name: string; subDomain: string };
  person: { id: string; name: MemberName };
  selected: boolean;
}
