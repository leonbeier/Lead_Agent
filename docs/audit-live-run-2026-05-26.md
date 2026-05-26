# Audit: Live run 2026-05-26T00:42:54.241Z

- Mode: live
- Companies synced: 35
- Contacts synced: 37
- Completion reason: runtime_limit_reached

## Aggregate findings

- 14 of 35 companies have no usable address in HubSpot.
- 13 of 35 companies have no HubSpot contact at all.
- 13 companies rely on generic mailbox contacts without a person name.
- 5 contacts store a company LinkedIn URL instead of a person profile.
- Only 3 contacts store a clear person LinkedIn profile.
- 7 English-targeted companies received a German email body.
- 3 German-targeted companies received an English LinkedIn connection request.
- All 35 companies are missing `ai_cc_linkedin_message` on the company object.
- All 35 companies are missing `ai_cc_email_subject` on the company object.
- All 35 companies are missing `ai_cc_phone_script` on the company object.

## High-priority defects to fix later

- Outreach property persistence is incomplete across the entire run: the company object consistently has `ai_cc_cold_call_linkedin` and `ai_cc_cold_call_email`, but not the full LinkedIn message, email subject, or phone script.
- Contact coverage is too weak: 13 synced companies have no associated contact and therefore also no outreach notes.
- Address extraction is noisy or wrong for multiple companies. Some addresses are scraped marketing copy, country-only placeholders, years, phone numbers, or article headlines.
- Contact extraction still admits obvious junk identities, for example `Addwebsolution`, `Deutsche Unternehmen`, `Our Customers`, `Roima Intelligence`, and multiple executive names without any reachable contact channel.
- LinkedIn enrichment frequently attaches company pages to contact records instead of person profiles.
- Language control is inconsistent. Several English-targeted companies received German email copy, and some German-targeted companies received English connection requests.

## Company review

- Elunic: cat=integrator_vision_industrial_ai; address=Erika-Mann-Str. 23, Munich, 80636, Germany; contacts=info@elunic.com (info@elunic.com / 089416173730 / https://www.linkedin.com/company/elunic-ag); issues=missing linkedin_message, missing email_subject, missing phone_script, DE target but EN LI request, company linkedin stored on contact
- Optware: cat=integrator_general_ai; address=Pruefeninger Strasse 20, Regensburg, 93049, Germany; contacts=info@optware.de (info@optware.de / +49 941 85099600); issues=missing linkedin_message, missing email_subject, missing phone_script
- Energent: cat=integrator_general_ai; address=2026 Top AI-Powered Vision Inspection Systems | Energent.ai, Market Assessment of AI-Powered Vision Inspection Systems, 2026, Belgium; contacts=Kimi Kong (admin@energent.ai); issues=missing linkedin_message, missing email_subject, missing phone_script
- Addwebsolution: cat=integrator_general_ai; address=Sales | Kawaguchi-Shi, JAPAN 333-0834 Saitama Prefecture, Kawaguchi-Shi, Angyoryo Negishi 1160-1 House Suzuran 103A, United States, NJ 07601, Germany; contacts=Addwebsolution; issues=missing linkedin_message, missing email_subject, missing phone_script
- inpro: cat=integrator_vision_industrial_ai; address=Steinplatz 2, Berlin, D-10623, Germany; contacts=info@inpro.de (info@inpro.de / +49 30 399 97-0 / https://de.linkedin.com/company/inpro-innovationsgesellschaft-f-r-fortgeschrittene-produktionssysteme-in-der-fahrzeugindustrie-mbh); issues=missing linkedin_message, missing email_subject, missing phone_script, company linkedin stored on contact
- Activeinspection: cat=integrator_vision_industrial_ai; address=(616) 425-9030, Roger B Chaffee Memorial Blvd SE, 3540; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Imr Le: cat=integrator_vision_industrial_ai; address=Sachtleben Strasse 1, Lennestadt-Meggen, 57368, Germany; contacts=info@imr-le.de (info@imr-le.de / +492721600750); issues=missing linkedin_message, missing email_subject, missing phone_script
- Clickpuls: cat=integrator_general_ai; address=Leonard-Bernstein-Strasse 10, Wien, 1220, Austria; contacts=Mathias Ziehengraser (hallo@clickpuls.com / +436706512518); issues=missing linkedin_message, missing email_subject, missing phone_script
- Degautomazioni: cat=integrator_vision_industrial_ai; address=missing; contacts=Salvatore Recupero; info@degautomazioni.it (info@degautomazioni.it / 390432975121 / https://www.linkedin.com/company/d-e-g-group-srl); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script, company linkedin stored on contact
- Automationwr: cat=integrator_vision_industrial_ai; address=Messerschmittstrasse 7, Muenchen, 80992, Germany; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Ing Buero Rothfuss: cat=integrator_vision_industrial_ai; address=Riedlinger Str. 8, Stuttgart, 70327, Germany; contacts=info@ing-buero-rothfuss.de (info@ing-buero-rothfuss.de / +49-711/9183444); issues=missing linkedin_message, missing email_subject, missing phone_script
- Fibervision: cat=integrator_vision_industrial_ai; address=Germany; contacts=info@fibervision.de (info@fibervision.de / +49 2405 4548-0); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script, DE target but EN LI request
- Astekgroup: cat=integrator_general_ai; address=Belgium; contacts=Henri Drouin; Julien Gavaldon; Quentin Gillet; Ornella; issues=missing address, missing linkedin_message, missing email_subject, missing phone_script
- Ar Controls: cat=integrator_vision_industrial_ai; address=missing; contacts=sales@ar-controls.co.uk (sales@ar-controls.co.uk / 08453381902); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script
- Perito Consulting: cat=integrator_vision_industrial_ai; address=missing; contacts=Francisco (fmmperito@hotmail.com); Vaishnavi Patil; Maurizio Perito (https://www.linkedin.com/in/maurizio-perito-a8766320); Roima Intelligence (+1 908 635 1950); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script, DE target but EN LI request
- Salttechno: cat=integrator_general_ai; address=Backed by 14+ years at Salt Technologies | 800+ projects delivered | Rated 4.9 on Clutch, Certified Backed by Salt Technologies, 27001; contacts=sales@salttechno.com (sales@salttechno.com / +18447662754 / https://www.linkedin.com/company/salttechnologies); Sujay Bhagwat (https://www.linkedin.com/in/sujayb); issues=missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email, broken address scrape, company linkedin stored on contact
- Eurekasystem: cat=integrator_vision_industrial_ai; address=Via G. Amendola, 24, Villorba, 31020; contacts=info@eurekasystem.it (info@eurekasystem.it / +390422263254); issues=missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Smartsurv: cat=integrator_vision_ai_consulting; address=Malmsheimer Str. 7, Sindelfingen, 71063, Germany; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Reruption: cat=integrator_general_ai; address=Falkertstrasse 2, Stuttgart, 70176, Germany; contacts=Christian Ensslen (https://de.linkedin.com/in/censslen); Deutsche Unternehmen (+49 175 5190660); issues=missing linkedin_message, missing email_subject, missing phone_script
- ASA: cat=integrator_vision_industrial_ai; address=Ostring 22, Mainhausen, 63533; contacts=office.de@asa-automation.com (office.de@asa-automation.com / 490618289520 / https://de.linkedin.com/company/asa-automation-gmbh); issues=missing linkedin_message, missing email_subject, missing phone_script, company linkedin stored on contact
- Parkvi: cat=integrator_vision_industrial_ai; address=Dasinger Str. 2, Augsburg, 86165, Germany; contacts=Represented By (info@parkvi.de / +4982165072933); issues=missing linkedin_message, missing email_subject, missing phone_script
- Scheck Engineering: cat=integrator_vision_ai_consulting; address=360° Video HEVC VR Adaptive Streaming, Academia, 2024, Germany; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Ae Vision: cat=integrator_vision_industrial_ai; address=Switzerland; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Zetamotion: cat=integrator_vision_industrial_ai; address=Belgium; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Ombrulla: cat=integrator_vision_industrial_ai; address=+44 7879 993892, Southwest Freeway, 6671; contacts=Our Customers (anoop@ombrulla.com / +447879993892); issues=missing linkedin_message, missing email_subject, missing phone_script
- FOQUS: cat=integrator_vision_industrial_ai; address=Belgium; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Lateralengine: cat=integrator_vision_industrial_ai; address=Belgium; contacts=Jaakko Rantala (jaakko.rantala@lateralengine.com / +358503462505); Miikka Himanka (support@lateralengine.com / +358505685150); info@lateralengine.com (info@lateralengine.com / +358505685150); Pyry Kanerva (pyry.kanerva@lateralengine.com); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Ai Inspect: cat=integrator_vision_industrial_ai; address=missing; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script
- WindleTek - Complete Inspection Automation Systems: cat=integrator_vision_industrial_ai; address=Integration Milestones 24, WindleTek founded to deliver complete inspection automation, 2024; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script
- StackMind - Senior: cat=integrator_general_ai; address=Germany; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Cloudweld: cat=integrator_general_ai; address=Germany; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Mv Center: cat=integrator_vision_industrial_ai; address=missing; contacts=kontakt@mv-center.com (kontakt@mv-center.com / +48 690 029 794); issues=missing address, missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Ibagroupit: cat=integrator_general_ai; address=2015 wurde das Unternehmen mit dem Managementqualitaetszertifikat ISO 9001: 2008,, Menschen, 12000, Europe; contacts=no contacts; issues=no contacts, missing linkedin_message, missing email_subject, missing phone_script
- Visor Solutions: cat=integrator_vision_industrial_ai; address=Europe; contacts=no contacts; issues=missing address, no contacts, missing linkedin_message, missing email_subject, missing phone_script, EN target but DE email
- Mst: cat=integrator_vision_industrial_ai; address=Im Weiherfeld 10, Ginsheim-Gustavsburg, 65462, Europe; contacts=Michael Stelzl (+4961349489100); issues=missing linkedin_message, missing email_subject, missing phone_script