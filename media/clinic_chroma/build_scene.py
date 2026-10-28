"""
Procedural 3D modern medical clinic  --  Blender 4.2 (bpy) scene builder.
Rendered on a pure chroma-key background (composited to #00FF00 afterwards).

Run:  python build_scene.py /tmp/clinic.blend
"""
import bpy
import math
import sys

BUILD = []

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene


# ----------------------------------------------------------------------------
# Materials
# ----------------------------------------------------------------------------
def setin(n, k, v):
    if k in n.inputs:
        n.inputs[k].default_value = v


def make_mat(name, base, rough=0.5, metal=0.0, transmission=0.0, ior=1.45,
             emission=None, emission_strength=0.0, spec=0.5, noise=None,
             coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    setin(b, "Base Color", (*base, 1.0))
    setin(b, "Roughness", rough)
    setin(b, "Metallic", metal)
    setin(b, "IOR", ior)
    setin(b, "Transmission Weight", transmission)
    setin(b, "Specular IOR Level", spec)
    setin(b, "Coat Weight", coat)
    setin(b, "Coat Roughness", 0.06)
    if emission is not None:
        setin(b, "Emission Color", (*emission, 1.0))
        setin(b, "Emission Strength", emission_strength)
    if noise:
        nscale, ramt, bump = noise
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = nscale
        tex.inputs["Detail"].default_value = 8.0
        tex.inputs["Roughness"].default_value = 0.62
        tex.location = (-760, 240)
        rng = nt.nodes.new("ShaderNodeMapRange")
        rng.inputs["From Min"].default_value = 0.36
        rng.inputs["From Max"].default_value = 0.64
        rng.inputs["To Min"].default_value = max(0.02, rough - ramt)
        rng.inputs["To Max"].default_value = rough + ramt
        rng.location = (-540, 240)
        nt.links.new(tex.outputs["Fac"], rng.inputs["Value"])
        nt.links.new(rng.outputs["Result"], b.inputs["Roughness"])
        bmp = nt.nodes.new("ShaderNodeBump")
        bmp.inputs["Strength"].default_value = bump
        bmp.inputs["Distance"].default_value = 0.03
        bmp.location = (-540, -120)
        nt.links.new(tex.outputs["Fac"], bmp.inputs["Height"])
        nt.links.new(bmp.outputs["Normal"], b.inputs["Normal"])
    return m


M = {}
M["white"] = make_mat("Plaster_White", (0.900, 0.895, 0.882), 0.50, noise=(60, 0.10, 0.045))
M["white_warm"] = make_mat("Plaster_Warm", (0.905, 0.895, 0.875), 0.56, noise=(90, 0.09, 0.045))
M["stone"] = make_mat("Stone_Travertine", (0.615, 0.578, 0.522), 0.45, noise=(150, 0.14, 0.10))
M["stone_dark"] = make_mat("Stone_Base", (0.400, 0.392, 0.378), 0.60, noise=(120, 0.10, 0.08))
M["concrete"] = make_mat("Concrete_Paving", (0.520, 0.512, 0.498), 0.80, noise=(70, 0.10, 0.08))
M["reveal"] = make_mat("Shadow_Reveal", (0.115, 0.115, 0.118), 0.75)

# deep tinted architectural glass -- reads dark and reflective
M["glass"] = make_mat("Glass_Tinted", (0.020, 0.024, 0.030), 0.30,
                      spec=0.22, coat=0.0, noise=(300, 0.02, 0.015))
M["glass_light"] = make_mat("Glass_Entrance", (0.045, 0.052, 0.062), 0.24,
                            spec=0.28, coat=0.0, noise=(300, 0.02, 0.015))
M["glass_spandrel"] = make_mat("Glass_Spandrel", (0.055, 0.058, 0.062), 0.22,
                               spec=0.5, coat=0.3, noise=(200, 0.05, 0.03))

M["light_strip"] = make_mat("Light_Strip", (0.90, 0.88, 0.84), 0.35,
                            emission=(1.0, 0.925, 0.815), emission_strength=11.0)

M["metal"] = make_mat("Metal_Anthracite", (0.052, 0.055, 0.060), 0.36, metal=0.85)
M["metal_light"] = make_mat("Metal_Aluminium", (0.610, 0.615, 0.620), 0.30, metal=0.92)
M["wood"] = make_mat("Wood_Walnut", (0.240, 0.150, 0.082), 0.42, noise=(180, 0.12, 0.14))
M["roof"] = make_mat("Roof_Membrane", (0.330, 0.332, 0.328), 0.90, noise=(40, 0.06, 0.08))

M["interior"] = make_mat("Interior_Wall", (0.780, 0.755, 0.715), 0.68,
                         emission=(1.0, 0.945, 0.870), emission_strength=1.2)
M["interior_ceil"] = make_mat("Interior_Ceiling", (0.820, 0.800, 0.770), 0.72,
                              emission=(1.0, 0.955, 0.895), emission_strength=1.6)
M["interior_floor"] = make_mat("Interior_Floor", (0.480, 0.450, 0.415), 0.60,
                               emission=(1.0, 0.93, 0.85), emission_strength=1.1)


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
def add_bevel(obj, width=0.016, segments=2):
    if width <= 0:
        return obj
    md = obj.modifiers.new("bev", "BEVEL")
    md.width = width
    md.segments = segments
    md.limit_method = "ANGLE"
    md.angle_limit = math.radians(40)
    md.harden_normals = True
    return obj


def box(name, size, loc, material, bevel=0.016, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    size = tuple(max(0.001, v * 1.004) for v in size)   # 0.4% overlap: no hairline gaps
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.rotation_euler = rot
    if material is not None:
        obj.data.materials.append(material)
    add_bevel(obj, min(bevel, min(size) * 0.32))
    BUILD.append(obj)
    return obj


def cyl(name, r, depth, loc, material, verts=28, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth,
                                        location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.materials.append(material)
    BUILD.append(obj)
    return obj


# ============================================================================
#  DIMENSIONS
# ============================================================================
LX, LY = 4.30, 3.85          # ground floor half extents (flush with the upper volume)
UX, UY = 4.30, 3.85          # upper volume half extents
Z0 = 0.32                    # finished floor level
G1 = 3.72                    # top of ground floor
SLAB = 0.28                  # cantilever slab thickness
SP0 = G1 + SLAB              # 4.00
WB0, WB1 = 4.62, 6.30        # first floor window band
R1 = 7.48                    # roof structural level
PARA = 8.02                  # parapet top

# --------------------------------------------------------------- base ------
box("base_plinth", (UX * 2 + 0.22, UY * 2 + 0.22, Z0), (0, 0, Z0 / 2), M["stone_dark"],
    bevel=0.016)
box("base_reveal", (UX * 2 - 0.02, UY * 2 - 0.02, 0.055),
    (0, 0, Z0 - 0.027), M["reveal"], bevel=0.0)

# ================================================== GROUND FLOOR ============
GH = G1 - Z0
# --- side walls (stone clad) ---
for sx in (-1, 1):
    box("gf_wall_%d" % sx, (0.34, LY * 2, GH), (sx * (LX - 0.17), 0, Z0 + GH / 2),
        M["white_warm"])
    box("gf_stone_%d" % sx, (0.055, LY * 2 - 0.02, GH - 0.60),
        (sx * (LX + 0.025), 0, Z0 + (GH - 0.60) / 2), M["stone"], bevel=0.005)
    # horizontal coursing joints
    for j in range(3):
        z = Z0 + 0.34 + j * 0.98
        box("gf_joint_%d_%d" % (sx, j), (0.030, LY * 2 - 0.04, 0.014),
            (sx * (LX + 0.056), 0, z), M["reveal"], bevel=0.0)
    # vertical joints
    for j in range(-3, 4):
        box("gf_vjoint_%d_%d" % (sx, j), (0.020, 0.014, GH - 0.62),
            (sx * (LX + 0.056), j * 1.02, Z0 + (GH - 0.60) / 2), M["reveal"], bevel=0.0)

# --- back wall (stone clad) ---
box("gf_wall_B", ((LX - 0.34) * 2, 0.34, GH), (0, LY - 0.17, Z0 + GH / 2), M["white_warm"])
box("gf_stone_B", ((LX - 0.36) * 2, 0.055, GH - 0.60), (0, LY + 0.025,
    Z0 + (GH - 0.60) / 2), M["stone"], bevel=0.005)
for j in range(3):
    box("gf_joint_B_%d" % j, ((LX - 0.38) * 2, 0.030, 0.014), (0, LY + 0.056,
        Z0 + 0.34 + j * 0.98), M["reveal"], bevel=0.0)
for j in range(-2, 3):
    box("gf_vjoint_B_%d" % j, (0.014, 0.020, GH - 0.62), (j * 1.02, LY + 0.056,
        Z0 + (GH - 0.60) / 2), M["reveal"], bevel=0.0)

# --- front: header band + corner returns ---
FB = 3.06                                  # top of glazing
box("gf_header", (LX * 2, 0.46, G1 - FB), (0, -(LY - 0.23), (FB + G1) / 2),
    M["white_warm"], bevel=0.014)
for sx in (-1, 1):
    box("gf_return_%d" % sx, (0.40, 0.40, GH), (sx * (LX - 0.20), -(LY - 0.20),
        Z0 + GH / 2), M["white_warm"])
    # stone reveal on the return
    box("gf_return_stone_%d" % sx, (0.42, 0.055, GH - 0.60),
        (sx * (LX - 0.20), -(LY + 0.028), Z0 + (GH - 0.60) / 2), M["stone"], bevel=0.004)

# --- storefront glazing (recessed 0.42 behind the facade plane) ---
GY = -(LY - 0.34)
GW = LX * 2 - 0.80
GZ0, GZ1 = Z0 + 0.04, FB
box("sf_glass", (GW, 0.05, GZ1 - GZ0), (0, GY, (GZ0 + GZ1) / 2), M["glass"], bevel=0.004)

BAYS = 6
for i in range(BAYS + 1):
    x = -GW / 2 + i * GW / BAYS
    box("sf_mull_%d" % i, (0.085, 0.16, GZ1 - GZ0 + 0.05),
        (x, GY - 0.055, (GZ0 + GZ1) / 2), M["metal"], bevel=0.006)
# head + base channels
box("sf_head", (GW, 0.16, 0.10), (0, GY - 0.055, GZ1 - 0.05), M["metal"], bevel=0.006)
box("sf_base", (GW, 0.17, 0.16), (0, GY - 0.06, GZ0 + 0.08), M["metal"], bevel=0.006)
box("sf_transom", (GW, 0.14, 0.075), (0, GY - 0.045, 2.58), M["metal"], bevel=0.005)
# soffit of the recess
box("sf_soffit", (GW + 0.1, 0.40, 0.05), (0, -(LY - 0.18), GZ1 + 0.025),
    M["white_warm"], bevel=0.004)

# --- entrance: the two centre bays are full height clear doors -------------
DW = 1.02
for k in (-1, 1):
    cx = k * DW / 2
    box("door_glass_%d" % k, (DW - 0.10, 0.04, 2.62), (cx, GY - 0.02, Z0 + 1.35),
        M["glass_light"], bevel=0.004)
    box("door_frame_t_%d" % k, (DW - 0.06, 0.12, 0.08), (cx, GY - 0.055, Z0 + 2.70),
        M["metal"], bevel=0.005)
    box("door_frame_b_%d" % k, (DW - 0.06, 0.12, 0.16), (cx, GY - 0.055, Z0 + 0.13),
        M["metal"], bevel=0.005)
    box("door_bar_%d" % k, (DW - 0.22, 0.055, 0.05), (cx, GY - 0.11, 1.06),
        M["metal_light"], bevel=0.008)
    box("door_rail_%d" % k, (DW - 0.10, 0.06, 0.10), (cx, GY - 0.055, 0.66),
        M["metal"], bevel=0.005)
box("door_stile", (0.07, 0.13, 2.66), (0, GY - 0.05, Z0 + 1.37), M["metal"], bevel=0.005)

# --- entrance canopy -------------------------------------------------------
CANZ = 3.02
box("canopy", (5.70, 2.85, 0.36), (0, -(LY + 1.425), CANZ + 0.18), M["white"],
    bevel=0.014)
box("canopy_band", (5.74, 2.89, 0.055), (0, -(LY + 1.425), CANZ + 0.35), M["metal"],
    bevel=0.010)
box("canopy_fascia_b", (5.44, 0.02, 0.09), (0, -(LY + 2.555), CANZ + 0.24), M["metal"],
    bevel=0.0)
box("canopy_edge", (5.74, 0.08, 0.045), (0, -(LY + 2.82), CANZ + 0.005), M["metal"],
    bevel=0.010)
box("canopy_under", (5.54, 2.69, 0.03), (0, -(LY + 1.385), CANZ - 0.014), M["wood"],
    bevel=0.004)
# recessed linear light in the canopy soffit
box("canopy_light", (4.90, 0.075, 0.02), (0, -(LY + 2.30), CANZ - 0.034),
    M["light_strip"], bevel=0.006)
box("canopy_light2", (4.90, 0.075, 0.02), (0, -(LY + 0.70), CANZ - 0.034),
    M["light_strip"], bevel=0.006)
box("sf_recess_light", (GW - 0.20, 0.05, 0.02), (0, -(LY - 0.20), GZ1 - 0.045),
    M["light_strip"], bevel=0.004)
# downlights on the ground-floor soffit / recess header
for i in range(4):
    x = -2.10 + i * 1.40
    cyl("dl_%d" % i, 0.055, 0.02, (x, -(LY - 0.24), FB - 0.055), M["light_strip"],
        verts=20)
for sx in (-1, 1):
    cyl("canopy_post_%d" % sx, 0.055, CANZ - Z0, (sx * 2.55, -(LY + 2.55),
        (Z0 + CANZ) / 2), M["metal"], verts=24)

# --- steps -----------------------------------------------------------------
box("step_1", (5.90, 0.42, 0.20), (0, -(LY + 0.21), Z0 - 0.10), M["concrete"],
    bevel=0.012)
box("step_2", (6.20, 0.40, 0.11), (0, -(LY + 0.62), Z0 - 0.245), M["concrete"],
    bevel=0.010)

# --- rear elevation articulation (seen at the start of the spin) -----------
box("gf_rear_reveal", ((LX - 0.36) * 2, 0.05, 0.10), (0, LY + 0.055, 2.85),
    M["metal"], bevel=0.004)
# recessed service door
box("gf_rear_door_frame", (1.30, 0.09, 2.35), (-1.55, LY + 0.045, Z0 + 1.20),
    M["metal"], bevel=0.006)
box("gf_rear_door", (1.18, 0.05, 2.25), (-1.55, LY + 0.075, Z0 + 1.18),
    M["glass"], bevel=0.004)
box("gf_rear_door_bar", (1.02, 0.05, 0.045), (-1.55, LY + 0.115, 1.05),
    M["metal_light"], bevel=0.006)
# louvred plant grille
box("gf_rear_louvre", (1.55, 0.06, 1.05), (1.60, LY + 0.055, Z0 + 1.55),
    M["metal"], bevel=0.005)
for i in range(5):
    box("gf_rear_slat_%d" % i, (1.45, 0.05, 0.035), (1.60, LY + 0.085, Z0 + 1.14 + i * 0.20),
        M["metal_light"], bevel=0.003)

# --- interior --------------------------------------------------------------
IX, IY = LX - 0.42, LY - 0.44
box("int_floor", (IX * 2, IY * 2, 0.06), (0, 0, Z0 + 0.06), M["interior_floor"], bevel=0.0)
box("int_ceiling", (IX * 2, IY * 2, 0.06), (0, 0, G1 - 0.20), M["interior_ceil"], bevel=0.0)
box("int_back", (IX * 2, 0.10, G1 - Z0 - 0.20), (0, IY - 0.05, (Z0 + G1) / 2 - 0.07),
    M["interior"], bevel=0.0)
for sx in (-1, 1):
    box("int_side_%d" % sx, (0.10, IY * 2, G1 - Z0 - 0.20),
        (sx * (IX - 0.05), 0, (Z0 + G1) / 2 - 0.07), M["interior"], bevel=0.0)
# reception counter + soft partition for depth behind the glass
box("int_counter", (2.30, 0.60, 1.05), (0.45, 1.05, Z0 + 0.58), M["white"], bevel=0.012)
box("int_counter_top", (2.36, 0.66, 0.05), (0.45, 1.05, Z0 + 1.12), M["wood"], bevel=0.005)
box("int_partition", (0.16, 3.10, G1 - Z0 - 0.34), (-1.60, 0.60, (Z0 + G1) / 2 - 0.14),
    M["white_warm"], bevel=0.006)
box("int_partition2", (2.60, 0.16, G1 - Z0 - 0.34), (-0.35, 2.05, (Z0 + G1) / 2 - 0.14),
    M["white_warm"], bevel=0.006)

# hidden solid core (safety net against any interior see-through)
box("core", ((LX - 0.30) * 2, (LY - 0.30) * 2, R1 - 0.30), (0, 0, (Z0 + R1) / 2 - 0.10),
    M["reveal"], bevel=0.0)

# ================================================== FIRST FLOOR ============
# cantilever slab
box("uf_slab", (UX * 2, UY * 2, SLAB), (0, 0, G1 + SLAB / 2), M["white"], bevel=0.018)
box("uf_soffit_wood", (UX * 2 - 0.12, UY * 2 - 0.12, 0.03), (0, 0, G1 + SLAB + 0.014),
    M["wood"], bevel=0.004)
box("uf_slab_under", (LX * 2 - 0.06, LY * 2 - 0.06, 0.05), (0, 0, G1 + 0.005),
    M["reveal"], bevel=0.004)

# spandrel below the ribbon window
for sx in (-1, 1):
    box("uf_spandrel_%d" % sx, (0.32, UY * 2, WB0 - SP0), (sx * (UX - 0.16), 0,
        (SP0 + WB0) / 2), M["white"])
box("uf_spandrel_F", (UX * 2, 0.32, WB0 - SP0), (0, -(UY - 0.16), (SP0 + WB0) / 2),
    M["white"])
box("uf_spandrel_B", (UX * 2, 0.32, WB0 - SP0), (0, (UY - 0.16), (SP0 + WB0) / 2),
    M["white"])
# head band
for sx in (-1, 1):
    box("uf_head_%d" % sx, (0.32, UY * 2, R1 - WB1), (sx * (UX - 0.16), 0,
        (WB1 + R1) / 2), M["white"])
box("uf_head_F", (UX * 2, 0.32, R1 - WB1), (0, -(UY - 0.16), (WB1 + R1) / 2), M["white"])
box("uf_head_B", (UX * 2, 0.32, R1 - WB1), (0, (UY - 0.16), (WB1 + R1) / 2), M["white"])

# lit interior mass
box("uf_interior", ((UX - 0.46) * 2, (UY - 0.46) * 2, R1 - SP0 - 0.02),
    (0, 0, (SP0 + R1) / 2), M["interior"], bevel=0.0)

# ribbon glazing, inset 0.30
GI = 0.44
box("uf_glass_F", ((UX - GI) * 2, 0.05, WB1 - WB0), (0, -(UY - GI), (WB0 + WB1) / 2),
    M["glass"], bevel=0.004)
box("uf_glass_B", ((UX - GI) * 2, 0.05, WB1 - WB0), (0, (UY - GI), (WB0 + WB1) / 2),
    M["glass"], bevel=0.004)
for sx in (-1, 1):
    box("uf_glass_%d" % sx, (0.05, (UY - GI) * 2, WB1 - WB0), (sx * (UX - GI), 0,
        (WB0 + WB1) / 2), M["glass"], bevel=0.004)

# corner piers -- deliberately proud of both facade planes to avoid coplanar faces
for sx in (-1, 1):
    for sy in (-1, 1):
        box("uf_pier_%d_%d" % (sx, sy), (0.34, 0.34, R1 - SP0 + 0.02),
            (sx * (UX - 0.15), sy * (UY - 0.15), (SP0 + R1) / 2), M["white"])

# spandrel panel at the sill of the ribbon window (adds a crisp horizontal line)
for sy in (-1, 1):
    box("uf_sill_%d" % sy, (UX * 2 - 0.66, 0.10, 0.10), (0, sy * (UY - 0.32),
        WB0 + 0.05), M["metal"], bevel=0.005)

# vertical white fins, front & back
FIN_N = 6
for i in range(FIN_N + 1):
    x = -UX + 0.16 + i * (UX * 2 - 0.32) / FIN_N
    box("fin_F_%d" % i, (0.17, GI + 0.14, WB1 - WB0 + 0.12),
        (x, -UY + GI / 2 + 0.07, (WB0 + WB1) / 2), M["white"], bevel=0.010)
    box("fin_B_%d" % i, (0.17, GI + 0.14, WB1 - WB0 + 0.12),
        (x, UY - GI / 2 - 0.07, (WB0 + WB1) / 2), M["white"], bevel=0.010)
FIN_S = 5
for sx in (-1, 1):
    for i in range(FIN_S + 1):
        y = -UY + 0.16 + i * (UY * 2 - 0.32) / FIN_S
        box("fin_S_%d_%d" % (sx, i), (GI + 0.14, 0.17, WB1 - WB0 + 0.12),
            (sx * (UX - GI / 2 - 0.07), y, (WB0 + WB1) / 2), M["white"], bevel=0.010)

# window head / sill shadow reveals
for sy in (-1, 1):
    box("uf_head_reveal_%d" % sy, (UX * 2 - 0.66, 0.06, 0.05), (0, sy * (UY - 0.33),
        WB1 + 0.03), M["reveal"], bevel=0.0)

# ================================================== ROOF ===================
box("roof_slab", (UX * 2 - 0.02, UY * 2 - 0.02, 0.14), (0, 0, R1 + 0.07), M["roof"],
    bevel=0.010)
box("roof_deck", (UX * 2 - 0.70, UY * 2 - 0.70, 0.03), (0, 0, R1 + 0.155), M["roof"],
    bevel=0.004)

PH = PARA - R1 - 0.14
for sx in (-1, 1):
    box("parapet_%d" % sx, (0.26, UY * 2, PH), (sx * (UX - 0.13), 0, R1 + 0.14 + PH / 2),
        M["white"], bevel=0.012)
for sy in (-1, 1):
    box("parapet_y_%d" % sy, (UX * 2 - 0.52, 0.26, PH), (0, sy * (UY - 0.13),
        R1 + 0.14 + PH / 2), M["white"], bevel=0.012)
for sx in (-1, 1):
    box("coping_%d" % sx, (0.30, UY * 2 + 0.02, 0.045), (sx * (UX - 0.13), 0,
        PARA), M["metal_light"], bevel=0.006)
for sy in (-1, 1):
    box("coping_y_%d" % sy, (UX * 2 - 0.56, 0.30, 0.045), (0, sy * (UY - 0.13),
        PARA), M["metal_light"], bevel=0.006)

# roof plant / louvre screen (set back, low)
PX, PY = 1.25, 0.85
PCX, PCY = -0.60, 1.15
box("plant_box", (PX * 2, PY * 2, 0.82), (PCX, PCY, R1 + 0.16 + 0.41), M["white"],
    bevel=0.012)
for i in range(6):
    box("louvre_%d" % i, (PX * 2 - 0.16, 0.035, 0.05),
        (PCX, PCY - PY + 0.05, R1 + 0.36 + i * 0.085), M["metal"], bevel=0.004)
box("plant_cap", (PX * 2 + 0.05, PY * 2 + 0.05, 0.055), (PCX, PCY, R1 + 0.16 + 0.85),
    M["metal_light"], bevel=0.006)
# small louvre grille on the rear roof edge
box("roof_vent", (0.90, 0.30, 0.50), (1.90, 1.30, R1 + 0.16 + 0.25), M["metal"],
    bevel=0.008)


# ============================================================================
#  PIVOT
# ============================================================================
pivot = bpy.data.objects.new("ClinicPivot", None)
sc.collection.objects.link(pivot)
pivot.empty_display_size = 2.0
for o in BUILD:
    o.parent = pivot

# ============================================================================
#  CAMERA (fixed, never animated)
# ============================================================================
CAM_DIST = 31.0
CAM_H = 6.2
TARGET_Z = 4.25
cam_data = bpy.data.cameras.new("Cam")
cam_data.lens = 52.0
cam_data.sensor_fit = "HORIZONTAL"
cam_data.sensor_width = 36.0
cam = bpy.data.objects.new("Camera", cam_data)
sc.collection.objects.link(cam)
cam.location = (0.0, -CAM_DIST, CAM_H)
sc.camera = cam

tgt = bpy.data.objects.new("CamTarget", None)
sc.collection.objects.link(tgt)
tgt.location = (0.0, 0.0, TARGET_Z)
con = cam.constraints.new("TRACK_TO")
con.target = tgt
con.track_axis = "TRACK_NEGATIVE_Z"
con.up_axis = "UP_Y"

# ============================================================================
#  LIGHTING
# ============================================================================
world = bpy.data.worlds.new("World")
sc.world = world
world.use_nodes = True
wnt = world.node_tree
bg = wnt.nodes["Background"]
sky = wnt.nodes.new("ShaderNodeTexSky")
sky.sky_type = "NISHITA"
sky.sun_disc = False
sky.sun_elevation = math.radians(38)
sky.sun_rotation = math.radians(-125)
sky.altitude = 200.0
sky.air_density = 1.0
sky.dust_density = 1.6
sky.ozone_density = 1.0
# lift the sky a touch so the white plaster stays neutral instead of blue
sky.location = (-600, 0)
wnt.links.new(sky.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.42

# neutral grey card behind the camera -> soft, colour-neutral reflections in the glazing
env_tex = wnt.nodes.new("ShaderNodeTexEnvironment")
wnt.nodes["Background"].location = (200, 0)
_w = wnt.nodes.new("ShaderNodeTexCoord")
_w.location = (-1200, 0)


def area(name, loc, size, energy, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, "AREA")
    d.shape = "RECTANGLE"
    d.size = size[0]
    d.size_y = size[1]
    d.energy = energy
    d.color = color
    o = bpy.data.objects.new(name, d)
    sc.collection.objects.link(o)
    o.location = loc
    tc = o.constraints.new("TRACK_TO")
    tc.target = tgt
    tc.track_axis = "TRACK_NEGATIVE_Z"
    tc.up_axis = "UP_Y"
    return o


area("Key", (-15.0, -15.0, 19.0), (6.0, 6.0), 8200, color=(1.0, 0.958, 0.910))
area("Fill", (18.0, -12.0, 4.5), (11.0, 11.0), 520, color=(0.95, 0.975, 1.0))
area("Rim", (7.0, 18.0, 12.0), (11.0, 9.0), 1500, color=(1.0, 1.0, 1.0))
area("Bounce", (-2.0, -13.0, -5.0), (15.0, 9.0), 120, color=(1.0, 0.98, 0.95))
area("Top", (2.0, 3.0, 26.0), (11.0, 11.0), 620, color=(1.0, 1.0, 1.0))
area("SideL", (-26.0, -2.0, 9.0), (12.0, 12.0), 330, color=(1.0, 0.99, 0.98))
area("SideR", (26.0, -2.0, 9.0), (12.0, 12.0), 330, color=(1.0, 0.99, 0.98))

sun_d = bpy.data.lights.new("Sun", "SUN")
sun_d.energy = 6.0
sun_d.angle = math.radians(1.1)
sun = bpy.data.objects.new("Sun", sun_d)
sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(55), 0, math.radians(-48))

# ============================================================================
#  RENDER
# ============================================================================
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = 36
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.022
sc.cycles.use_denoising = True
sc.cycles.denoiser = "OPENIMAGEDENOISE"
sc.cycles.max_bounces = 4
sc.cycles.diffuse_bounces = 3
sc.cycles.glossy_bounces = 3
sc.cycles.transmission_bounces = 0
sc.cycles.transparent_max_bounces = 4
sc.cycles.caustics_reflective = False
sc.cycles.caustics_refractive = False
sc.cycles.sample_clamp_indirect = 2.0
sc.cycles.use_fast_gi = False

sc.render.resolution_x = 1080
sc.render.resolution_y = 1920
sc.render.resolution_percentage = 100
sc.render.film_transparent = True
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.image_settings.color_depth = "16"
sc.render.image_settings.compression = 25

sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Medium High Contrast"
sc.view_settings.exposure = -0.35

sc.frame_start = 1
sc.frame_end = 120
sc.render.fps = 24
sc.render.use_persistent_data = True
sc.render.use_motion_blur = True
sc.render.motion_blur_shutter = 0.5
sc.cycles.motion_blur_position = "CENTER"
sc.cycles.rolling_shutter = False

# bake the 180-degree turn: fast at t=0, decelerating to a dead stop
piv = pivot
EASE_POW = 2.2
piv.rotation_mode = "XYZ"
for f in range(sc.frame_start, sc.frame_end + 1):
    u = (f - sc.frame_start) / float(sc.frame_end - sc.frame_start)
    p = 1.0 - (1.0 - u) ** EASE_POW          # cubic-ish ease-out
    ang = math.radians(-180.0) * (1.0 - p)   # starts at -180 deg, ends at 0
    piv.rotation_euler = (0.0, 0.0, ang)
    piv.keyframe_insert("rotation_euler", index=2, frame=f)
for fc in piv.animation_data.action.fcurves:
    for kp in fc.keyframe_points:
        kp.interpolation = "LINEAR"
piv.rotation_euler = (0.0, 0.0, 0.0)

if len(sys.argv) > 1:
    bpy.ops.wm.save_as_mainfile(filepath=sys.argv[1])
    print("SAVED:", sys.argv[1])
print("OBJECTS:", len(BUILD))
