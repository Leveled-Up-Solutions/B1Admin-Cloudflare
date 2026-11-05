import { PlanHelper } from "@churchapps/helpers";
import { DateHelper } from "@churchapps/apphelper";
import type { PlanItemInterface } from "../../helpers/Interfaces";

// Re-export lesson interfaces from @churchapps/helpers for convenience
export {
  type LessonActionInterface,
  type LessonSectionInterface,
  type LessonVenueInterface,
  type LessonInfoInterface,
  type LessonStudyInterface,
  type LessonProgramInterface,
  type LessonTreeInterface,
  type LessonActionTreeInterface,
  type VenueActionResponseInterface
} from "@churchapps/helpers";

// Re-export utility functions from PlanHelper for backwards compatibility
export const formatTime = PlanHelper.formatTime;
// The package helper only reads direct children's seconds; the editor also accepts
// API null parent IDs, which are unrelated to this calculation.
export const getSectionDuration = (section: Pick<PlanItemInterface, "children">): number =>
  PlanHelper.getSectionDuration({ children: section.children?.map(child => ({ seconds: child.seconds })) });

export const formatClockTime = (startTime: Date | string | undefined, totalSecs: number): string => {
  if (!startTime) return "";
  const d = new Date(startTime);
  if (isNaN(d.getTime())) return "";
  d.setSeconds(d.getSeconds() + totalSecs);
  return d.toLocaleTimeString(DateHelper.locale, { hour: "numeric", minute: "2-digit" });
};
