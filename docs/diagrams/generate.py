# Generates the two diagrams in IKNL house style colours (huisstijlhandboek 3.2) as SVG.
import sys
OUT = sys.argv[1]
BLUE, DARK = '#11B5E9', '#006D8C'          # logo colours
ORANGE, MAGENTA = '#EC7A08', '#C30072'     # supporting colours
TINT, DTINT, GREY, LINE = '#E7F7FD', '#DCEDF2', '#595959', '#B8C4C8'
FONT = 'Verdana, Calibri, Arial, sans-serif'

def esc(s): return s.replace('&', '&amp;').replace('<', '&lt;')
def text(x, y, s, size=13, fill='#000', weight='normal', anchor='start', style=''):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}" text-anchor="{anchor}" {style}>{esc(s)}</text>'
def box(x, y, w, h, fill, stroke='none', sw=1.5, rx=12, dash=''):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d}/>'
def head(w, h, title, sub):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" font-family="{FONT}">
<defs>
{''.join(f'<marker id="a{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="{c}"/></marker>' for n, c in (('d', DARK), ('m', MAGENTA), ('o', ORANGE), ('g', GREY)))}
</defs>
<rect width="{w}" height="{h}" fill="#fff"/>
<path d="M24 78 Q24 40 62 40 H{w-24}" fill="none" stroke="{DARK}" stroke-width="1.5"/>
{text(62, 84, title, 26, '#000')}
{text(62, 108, sub, 13, GREY)}
'''
def arrow(pts, color='d', dash='', sw=2, start=False):
    c = {'d': DARK, 'm': MAGENTA, 'o': ORANGE, 'g': GREY}[color]
    d = 'M' + ' L'.join(f'{x} {y}' for x, y in pts)
    da = f' stroke-dasharray="{dash}"' if dash else ''
    ms = f' marker-start="url(#a{color})"' if start else ''
    return f'<path d="{d}" fill="none" stroke="{c}" stroke-width="{sw}" stroke-linejoin="round"{da} marker-end="url(#a{color})"{ms}/>'
def badge(x, y, n, color=DARK):
    return f'<circle cx="{x}" cy="{y}" r="11" fill="{color}"/>' + text(x, y + 4.5, str(n), 12, '#fff', 'bold', 'middle')
def person(x, y, label):
    return (f'<circle cx="{x}" cy="{y}" r="11" fill="{DARK}"/><path d="M{x-19} {y+42} Q{x-19} {y+15} {x} {y+15} Q{x+19} {y+15} {x+19} {y+42} z" fill="{DARK}"/>'
            + text(x, y + 62, label, 13, '#000', 'bold', 'middle'))
def comp(x, y, w, h, title, lines, custom=False):
    s = box(x, y, w, h, '#fff', ORANGE if custom else BLUE, 2.5 if custom else 1.5)
    s += text(x + 14, y + 24, title, 14, '#000', 'bold')
    for i, l in enumerate(lines): s += text(x + 14, y + 44 + i * 17, l, 12, GREY)
    return s

# ---------------------------------------------------------------- architecture --
W, H = 1280, 800
s = head(W, H, 'Architecture', 'Guidelines in the EHR with CDS Hooks: the components of the demo and how they are connected')
s += person(90, 205, 'Administrator') + person(90, 330, 'Clinician')
s += text(90, 410, 'in a browser', 12, GREY, anchor='middle')
# EHR
s += box(180, 130, 550, 450, TINT, 'none', rx=18)
s += text(200, 158, 'EHR: OpenMRS 3', 17, DARK, 'bold') + text(352, 158, 'keeps its data in its own data model, not in FHIR', 12, GREY)
s += comp(200, 175, 245, 72, 'Frontend', ['OpenMRS 3 patient chart, admin'])
s += comp(465, 175, 245, 72, 'CDS Hooks module', ['configuration page', 'cards in the patient chart'], True)
s += comp(200, 275, 510, 72, 'Edge proxy (nginx)', ['relay for CDS Hooks calls · access tokens for the FHIR API'], True)
s += comp(200, 375, 245, 72, 'FHIR API', ['translates the EHR’s data to', 'FHIR on request (FHIR2 module)'])
s += comp(465, 375, 245, 72, 'REST API', ['the EHR’s own API: patients,', 'encounters, orders, concepts'])
s += comp(200, 475, 380, 86, 'Database', ['OpenMRS data model (MariaDB)', 'code systems: mapped to concepts by configuration'])
# CDS
s += box(900, 130, 350, 450, DTINT, 'none', rx=18)
s += text(920, 158, 'CDS service: HAPI FHIR', 17, DARK, 'bold')
s += comp(920, 175, 310, 72, 'CDS Hooks endpoint', ['/cds-services: discovery, and one', 'service per PlanDefinition'])
s += comp(920, 275, 310, 72, 'Clinical reasoning', ['PlanDefinition $apply · CQL engine'])
s += comp(920, 375, 310, 105, 'Guidelines (FHIR)', ['PlanDefinition · ActivityDefinition', 'Library with CQL', 'ValueSet · CodeSystem'])
# internal arrows
s += arrow([(125, 215), (198, 215)], 'g') + arrow([(125, 335), (160, 335), (160, 225), (198, 225)], 'g')
s += f'<line x1="445" y1="211" x2="465" y2="211" stroke="{GREY}" stroke-width="2"/>'
s += arrow([(587, 249), (587, 273)]) + arrow([(322, 449), (322, 473)], 'g') + arrow([(540, 449), (540, 473)], 'g')
s += arrow([(1075, 249), (1075, 273)], 'g') + arrow([(1075, 349), (1075, 373)], 'g')
# between EHR and CDS
s += arrow([(712, 293), (805, 293), (805, 200), (918, 200)]) + badge(805, 246, 1)
s += arrow([(918, 222), (835, 222), (835, 315), (712, 315)]) + badge(835, 268, 3)
s += arrow([(918, 238), (865, 238), (865, 335), (712, 335)], 'm', '6 4') + badge(865, 300, 2, MAGENTA)
s += arrow([(322, 349), (322, 373)], 'm', '6 4')
# guideline project and loader
s += box(180, 630, 380, 130, '#fff', DARK, 1.5, 12)
s += text(196, 656, 'Guideline project', 14, '#000', 'bold') + text(330, 656, 'e.g. cpg-example', 12, GREY)
for i, l in enumerate(['input/cql: logic (CQL)', 'input/resources, input/vocabulary: guideline (FHIR)', 'input/tests: test patients (FHIR)']):
    s += text(196, 682 + i * 21, l, 12, GREY)
s += comp(640, 660, 190, 70, 'Loader', ['Node.js scripts'], True)
s += arrow([(562, 695), (638, 695)], 'o')
s += arrow([(735, 658), (735, 610), (640, 610), (640, 449)], 'o')
s += text(628, 600, 'test patients, translated to', 11, GREY, anchor='end') + text(628, 615, 'OpenMRS patients and orders', 11, GREY, anchor='end')
s += arrow([(832, 695), (880, 695), (880, 440), (918, 440)], 'o') + text(890, 600, 'guidelines,', 11, GREY) + text(890, 615, 'from source', 11, GREY)
# legend
lx, ly = 930, 650
s += badge(lx + 11, ly, 1) + text(lx + 30, ly + 4.5, 'Hook call (patient-view), with FHIR data', 12)
s += badge(lx + 11, ly + 27, 2, MAGENTA) + text(lx + 30, ly + 31.5, 'Or: the service fetches the data itself', 12)
s += badge(lx + 11, ly + 54, 3) + text(lx + 30, ly + 58.5, 'Cards with recommendations', 12)
s += box(lx, ly + 84, 22, 14, '#fff', BLUE, 1.5, 4) + text(lx + 30, ly + 96, 'stock open source', 12)
s += box(lx + 170, ly + 84, 22, 14, '#fff', ORANGE, 2.5, 4) + text(lx + 200, ly + 96, 'made for this demo', 12)
open(f'{OUT}/architecture.svg', 'w').write(s + '</svg>\n')

# ----------------------------------------------------------------- interaction --
W, H = 1280, 990
s = head(W, H, 'Interaction', 'CDS Hooks between the EHR and the CDS service: set-up by the administrator, and what happens when a chart is opened')
L = {'user': 144, 'mod': 420, 'srv': 760, 'cds': 1110}
heads = [('user', 'User', 'in a browser', DARK, '#fff'), ('mod', 'EHR: CDS Hooks module', 'OpenMRS 3 frontend', BLUE, '#fff'),
         ('srv', 'EHR: server', 'relay · FHIR API · settings', BLUE, '#fff'), ('cds', 'CDS service', 'HAPI FHIR', DARK, '#fff')]
TOP, BOT = 190, 955
# sections
s += box(24, 205, W - 48, 215, TINT, rx=16)
s += box(24, 435, W - 48, 530, DTINT, rx=16)
for k, t, sub, fill, fg in heads:
    x = L[k]
    s += f'<line x1="{x}" y1="{TOP}" x2="{x}" y2="{BOT}" stroke="{LINE}" stroke-width="1.5" stroke-dasharray="4 4"/>'
    s += box(x - 120, 128, 240, 56, fill, rx=12) + text(x, 152, t, 14, fg, 'bold', 'middle') + text(x, 171, sub, 11.5, fg, anchor='middle')
s += box(36, 213, 250, 24, TINT, rx=4) + text(40, 230, 'Set-up, once', 14, DARK, 'bold') + text(152, 230, 'by the administrator', 12, GREY)
s += box(36, 443, 400, 24, DTINT, rx=4) + text(40, 460, 'Every time a patient chart is opened', 14, DARK, 'bold') + text(338, 460, 'by a clinician', 12, GREY)
n = [0]
def msg(a, b, y, label, ret=False, color='d', relay=False, note=''):
    n[0] += 1
    xa, xb = L[a], L[b]
    d = 1 if xb > xa else -1
    out = arrow([(xa + 4 * d, y), (xb - 4 * d, y)], color, '6 4' if ret else '', 1.8)
    lx = min(xa, xb) + 34
    out += badge(min(xa, xb) + 18, y - 13, n[0], MAGENTA if color == 'm' else DARK)
    out += text(lx, y - 8, label, 12.5)
    if note: out += text(lx, y + 16, note, 11, GREY)
    if relay: out += f'<circle cx="{L["srv"]}" cy="{y}" r="5" fill="#fff" stroke="{DARK}" stroke-width="1.8"/>' + text(L['srv'] + 9, y + 15, 'relay', 10.5, GREY)
    return out
s += msg('user', 'mod', 268, 'Register the discovery URL')
s += msg('mod', 'cds', 306, 'GET /cds-services', relay=True)
s += msg('cds', 'mod', 344, 'Services: id, hook (patient-view), prefetch templates', ret=True, relay=True)
s += msg('user', 'mod', 382, 'Enable services')
s += msg('mod', 'srv', 408, 'Save the configuration')
s += msg('user', 'mod', 498, 'Open a patient chart', note='the patient-view hook fires')
s += msg('mod', 'cds', 544, 'GET /cds-services', relay=True)
s += msg('cds', 'mod', 582, 'Current prefetch templates', ret=True, relay=True)
# option A
s += box(300, 600, 590, 92, 'none', DARK, 1.2, 10, '3 3') + text(436, 618, 'Patient data, option A: prefetch', 11.5, DARK, 'bold')
s += msg('mod', 'srv', 648, 'FHIR queries from the templates')
s += msg('srv', 'mod', 680, 'Patient, MedicationRequest, ServiceRequest, …', ret=True)
s += msg('mod', 'cds', 732, 'POST /cds-services/{id}: hook, context (patient, user), prefetch, FHIR API address + access token', relay=True)
# option B
s += box(640, 752, 596, 92, 'none', MAGENTA, 1.2, 10, '3 3') + text(772, 770, 'Patient data, option B: the service fetches what it still needs', 11.5, MAGENTA, 'bold')
s += msg('cds', 'srv', 800, 'FHIR queries, with the access token', color='m')
s += msg('srv', 'cds', 832, 'FHIR resources', ret=True, color='m')
# apply (self)
n[0] += 1
x = L['cds']
s += f'<path d="M{x} 862 h38 v24 h-30" fill="none" stroke="{DARK}" stroke-width="1.8" marker-end="url(#ad)"/>' + badge(x - 16, 874, n[0])
s += text(x - 34, 870, 'PlanDefinition $apply:', 12.5, anchor='end') + text(x - 34, 886, 'run the guideline’s CQL', 12.5, anchor='end')
s += msg('cds', 'mod', 916, 'Cards', ret=True, relay=True)
s += msg('mod', 'user', 944, 'Recommendations at the top of the chart', ret=True)
open(f'{OUT}/interaction.svg', 'w').write(s + '</svg>\n')
