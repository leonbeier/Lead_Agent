import { LeadCategory } from "../../src/types";

export interface LatestHubSpotCompanyResearchCase {
  companyName: string;
  websiteUrl: string;
  initialCategory: LeadCategory;
  expectedCategory: LeadCategory;
  evidence: string;
}

export const latestHubSpotCompanyResearch: LatestHubSpotCompanyResearchCase[] = [
  {
    companyName: "Ivy vision GmbH",
    websiteUrl: "https://ivy-vision.com",
    initialCategory: "integrator_vision_industrial_ai",
    expectedCategory: "other",
    evidence: "Builds custom-fit solutions in SAP and embedded systems domains and offers software consulting, software solutions, product and technical support."
  },
  {
    companyName: "LEITEK Informations- und Automatisierungstechnik GmbH",
    websiteUrl: "https://leitek.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Provides automation solutions for industry and small and medium-sized businesses worldwide with safe and innovative automation solutions."
  },
  {
    companyName: "Virocha Technovations Pvt. Ltd.",
    websiteUrl: "https://virocha.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Leading automation engineering solutions provider for industries with control systems integration, robotics, Industry 4.0, turnkey projects, PLC panels, and smart building solutions."
  },
  {
    companyName: "AZT",
    websiteUrl: "https://azt-a.ru",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Industrial automation and applied software integrator delivering PLC, SCADA and BMS software with full-cycle commissioning and engineering."
  },
  {
    companyName: "DELTA Computer Products GmbH",
    websiteUrl: "https://www.deltacomputer.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "machine_builder_ai_enablement",
    evidence: "Sells high-performance systems, GPU computing, servers, workstations, NVIDIA DGX systems and AI infrastructure as a product-led vendor rather than a project-led integrator."
  },
  {
    companyName: "SKL Robotics LTD",
    websiteUrl: "https://thehumanoid.ai",
    initialCategory: "integrator_general_ai",
    expectedCategory: "machine_builder_ai_enablement",
    evidence: "Builds commercially scalable humanoid robots and an AI framework for robot fleet orchestration across wheeled and bipedal platforms."
  },
  {
    companyName: "Lentil Robotics GmbH",
    websiteUrl: "https://www.lentilrobotics.com",
    initialCategory: "integrator_vision_industrial_ai",
    expectedCategory: "machine_builder_ai_enablement",
    evidence: "AI vision lab for industrial automation with its own software that enables robotics tasks and deploys patent-pending models quickly in production."
  },
  {
    companyName: "RnDeep GmbH",
    websiteUrl: "https://rndeep.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "irrelevant",
    evidence: "Offers custom tailored pipeline solutions and is hiring for a Pipeline Developer and Team Lead VFX/Animation role, which indicates media and animation pipeline automation rather than industrial AI delivery."
  },
  {
    companyName: "insensiv GmbH",
    websiteUrl: "https://insensiv.de",
    initialCategory: "integrator_vision_industrial_ai",
    expectedCategory: "camera_manufacturer_partner",
    evidence: "Develops and manufactures custom image-processing solutions and intelligent camera systems as an OEM component specialist with its own product portfolio."
  },
  {
    companyName: "isa industrieelektronik GmbH",
    websiteUrl: "https://isaweiden.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Engineering partner for control and drive technology plus software and microelectronics across industrial and water engineering projects."
  },
  {
    companyName: "UBH SOFTWARE & ENGINEERING GmbH",
    websiteUrl: "https://ubh.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Acts as a general contractor for warehouse and production automation with IT automation solutions, WMS, SCADA and production automation."
  },
  {
    companyName: "Ert Solutions",
    websiteUrl: "https://ert-solutions.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "machine_builder_ai_enablement",
    evidence: "Develops and supplies its own robotics products including mobile manipulators, industrial robots, fleet manager software and 3D image sensors."
  },
  {
    companyName: "Tripleye GmbH",
    websiteUrl: "https://tripleye.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "software_platform_embedding",
    evidence: "Provides an integrated data platform, AI/ML platform, autonomous software modules and an SDK and development platform for autonomy solutions."
  },
  {
    companyName: "Chromasens GmbH",
    websiteUrl: "https://chromasens.de",
    initialCategory: "integrator_vision_industrial_ai",
    expectedCategory: "camera_manufacturer_partner",
    evidence: "Machine vision manufacturer for line scan cameras, lighting systems and OEM imaging solutions for machine builders and system integrators."
  },
  {
    companyName: "AX Automation Services GmbH",
    websiteUrl: "https://ax-automation.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Industrial service provider for special machine and plant engineering with PLC programming, robot programming, engineering, assembly and control cabinet construction."
  },
  {
    companyName: "pixolus GmbH",
    websiteUrl: "https://pixolus.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "software_platform_embedding",
    evidence: "Develops mobile image-recognition solutions with scan modules and an SDK for Android and iOS that other app developers integrate into their own apps."
  },
  {
    companyName: "NETWALK GmbH",
    websiteUrl: "https://netwalk.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "other",
    evidence: "Broad software and engineering services company spanning infrastructure, cybersecurity, automotive embedded and design engineering without a clear industrial AI delivery specialization."
  },
  {
    companyName: "Novatec New Technologies",
    websiteUrl: "https://novatec.hr",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Provides turnkey industrial process control and automation solutions including PLC, HMI, DCS and SCADA programming."
  },
  {
    companyName: "project Automation & Consulting GmbH",
    websiteUrl: "https://project-ac.de",
    initialCategory: "integrator_general_ai",
    expectedCategory: "integrator_relevant_focus",
    evidence: "Industrial engineering and automation consultancy for machine building with planning, electrical and mechanical engineering, PLC, robotics and commissioning."
  },
  {
    companyName: "Objectis",
    websiteUrl: "https://objectis.com",
    initialCategory: "integrator_general_ai",
    expectedCategory: "software_platform_embedding",
    evidence: "Industrial software company with its own software platform, HMI auto-generation toolbox, InstantUX products and factory software products that customers embed into workflows."
  },
  {
    companyName: "opdi-tex GmbH",
    websiteUrl: "https://opdi-tex.de",
    initialCategory: "integrator_vision_industrial_ai",
    expectedCategory: "camera_manufacturer_partner",
    evidence: "Provides complete industrial camera-system solutions and develops individual image-processing systems and camera systems for production environments."
  }
];