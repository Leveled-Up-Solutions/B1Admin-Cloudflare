import type { ElementInterface, SectionInterface } from "../helpers/Interfaces";
import type { ElementInterface as WebsiteElement, SectionInterface as WebsiteSection } from "@churchapps/apphelper/website";

// The editor API uses null for root elements; apphelper's renderer uses an absent parent.
// Keep this conversion at the rendering boundary so saved editor data retains its API shape.
export const toWebsiteElement = (element: ElementInterface): WebsiteElement => ({
  ...element,
  parentId: element.parentId ?? undefined,
  elements: element.elements?.map(toWebsiteElement)
});

export const toWebsiteSection = (section: SectionInterface): WebsiteSection => ({
  ...section,
  elements: section.elements?.map(toWebsiteElement),
  sections: section.sections?.map(toWebsiteSection)
});
