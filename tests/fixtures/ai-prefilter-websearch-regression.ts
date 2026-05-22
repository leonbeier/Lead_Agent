import { LeadCategory } from "../../src/types";

export interface AiPrefilterWebsearchRegressionCase {
  companyName: string;
  websiteUrl: string;
  expectedCategory: LeadCategory;
  acceptedCategories?: LeadCategory[];
  notes: string;
}

export const aiPrefilterWebsearchRegressionCases: AiPrefilterWebsearchRegressionCase[] = [
  {
    companyName: "Image Access GmbH",
    websiteUrl: "https://www.imageaccess.de",
    expectedCategory: "machine_builder_ai_enablement",
    notes: "Machine-vision scan products and inline inspection hardware point to a machine-builder/productized OEM fit."
  },
  {
    companyName: "PlanV GmbH",
    websiteUrl: "https://planv.tech",
    expectedCategory: "integrator_relevant_focus",
    notes: "ASIC, FPGA, RTL and SoC engineering services fit a relevant technical integration and semiconductor-focused delivery profile."
  },
  {
    companyName: "zolitron.com",
    websiteUrl: "https://www.zolitron.com",
    expectedCategory: "other",
    notes: "Closed municipal operations platform with rollout help, but no clear build-on-top or external integrator fit."
  },
  {
    companyName: "SCOPE Engineering",
    websiteUrl: "https://www.scope-engineering.de",
    expectedCategory: "other",
    notes: "Broad engineering capacity site without a strong AI or specific ONE WARE fit path."
  },
  {
    companyName: "Udysseus GmbH",
    websiteUrl: "https://www.udysseus.com",
    expectedCategory: "other",
    notes: "General IoT, cloud and software agency profile without enough direct AI-integrator evidence."
  },
  {
    companyName: "cube vision GmbH",
    websiteUrl: "https://www.cubevision.de",
    expectedCategory: "other",
    notes: "Known company website, but the available site surface does not currently expose enough qualifying evidence beyond a generic presence."
  },
  {
    companyName: "Elma Electronic GmbH",
    websiteUrl: "https://www.elma.com",
    expectedCategory: "integrator_relevant_focus",
    notes: "Embedded systems, industrial control and system-integration capabilities in a relevant technical industry make this a relevant-focus integrator case."
  },
  {
    companyName: "SweepMe!",
    websiteUrl: "https://sweep-me.net",
    expectedCategory: "software_platform_embedding",
    notes: "Measurement automation software with Python device drivers and an extensible module/driver ecosystem fits platform embedding."
  },
  {
    companyName: "Accenture",
    websiteUrl: "https://www.accenture.com",
    expectedCategory: "integrator_general_ai",
    notes: "Large-scale AI consulting and delivery across industries is a general AI integrator profile."
  },
  {
    companyName: "IronFlock GmbH",
    websiteUrl: "https://www.ironflock.com",
    expectedCategory: "software_platform_embedding",
    notes: "Industrial app runtime, app studio, app distribution and OEM digital-service rollout are strong platform-embedding signals."
  },
  {
    companyName: "Lufthansa Industry Solutions GmbH & Co. KG",
    websiteUrl: "https://www.lufthansa-industry-solutions.com",
    expectedCategory: "integrator_general_ai",
    notes: "Customer-facing AI, automation and digital transformation delivery across multiple sectors fits a general AI integrator."
  },
  {
    companyName: "Yamasoft",
    websiteUrl: "https://www.yamasoft.dev",
    expectedCategory: "integrator_general_ai",
    notes: "Software engineering delivery with explicit AI and ML project work makes this a general AI integrator case."
  },
  {
    companyName: "TeDo Verlag",
    websiteUrl: "https://www.tedo-verlag.de",
    expectedCategory: "other",
    notes: "Publisher and industrial media business, not an AI integrator or platform fit."
  },
  {
    companyName: "statworx",
    websiteUrl: "https://www.statworx.com",
    expectedCategory: "integrator_general_ai",
    notes: "Established AI consultancy and implementation provider with broad AI delivery signals."
  },
  {
    companyName: "deepc",
    websiteUrl: "https://www.deepc.ai",
    expectedCategory: "software_platform_embedding",
    notes: "Radiology AI operating system, marketplace and integrations platform fits software platform embedding."
  },
  {
    companyName: "IDS Imaging Development Systems GmbH",
    websiteUrl: "https://www.ids-imaging.com",
    expectedCategory: "camera_manufacturer_partner",
    notes: "Industrial camera manufacturer with AI cameras and machine-vision portfolio fits camera manufacturer partner."
  },
  {
    companyName: "WFF IT-Service GmbH",
    websiteUrl: "https://www.wff-it.de",
    expectedCategory: "integrator_relevant_focus",
    acceptedCategories: ["integrator_relevant_focus", "integrator_general_ai"],
    notes: "Internal industrial IT, MES, EDI and manufacturing systems delivery clearly lands in an integrator bucket, with the exact subcategory intentionally tolerant."
  },
  {
    companyName: "FUSE-AI GmbH",
    websiteUrl: "https://www.fuse-ai.de",
    expectedCategory: "machine_builder_ai_enablement",
    notes: "Certified radiology AI product integrated as a plug-in into PACS/reporting workflows fits the product-led machine-builder bucket in this taxonomy."
  },
  {
    companyName: "AI Superior",
    websiteUrl: "https://aisuperior.com",
    expectedCategory: "integrator_vision_industrial_ai",
    notes: "AI services company with explicit computer-vision delivery and integration work, closest to the vision-integrator bucket."
  },
  {
    companyName: "DataVision",
    websiteUrl: "https://www.datavision.software",
    expectedCategory: "integrator_vision_industrial_ai",
    notes: "Custom AI systems for image and video analysis in production environments point to a vision-focused software integrator."
  },
  {
    companyName: "AIS Vision Systems S.L.",
    websiteUrl: "https://aisvision.com",
    expectedCategory: "integrator_vision_industrial_ai",
    notes: "Custom industrial vision, quality-control automation and deep-learning inspection are direct vision-integrator signals."
  }
];