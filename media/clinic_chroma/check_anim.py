import bpy, math
bpy.ops.wm.open_mainfile(filepath="/tmp/clinic.blend")
sc=bpy.context.scene
piv=bpy.data.objects['ClinicPivot']
prev=None
for f in [1,2,30,60,90,118,120]:
    sc.frame_set(f)
    z=math.degrees(piv.rotation_euler.z)
    print(f, round(z,2))
sc.frame_set(1); a=math.degrees(piv.rotation_euler.z)
sc.frame_set(2); b=math.degrees(piv.rotation_euler.z)
sc.frame_set(119); c=math.degrees(piv.rotation_euler.z)
sc.frame_set(120); d=math.degrees(piv.rotation_euler.z)
print('first-frame step', round(b-a,2), 'last-frame step', round(d-c,3), 'total', 180)
