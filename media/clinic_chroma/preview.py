import bpy
bpy.ops.wm.open_mainfile(filepath="/tmp/clinic.blend")
import sys, math, os
import bpy, sys, math, os
argv = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
outdir = argv[0] if argv else '/tmp/prev'
pct = int(argv[1]) if len(argv) > 1 else 40
samples = int(argv[2]) if len(argv) > 2 else 24
frames = [int(x) for x in argv[3].split(',')] if len(argv) > 3 else [1]
os.makedirs(outdir, exist_ok=True)
sc = bpy.context.scene
sc.render.resolution_percentage = pct
sc.cycles.samples = samples
sc.render.image_settings.color_depth = '8'
piv = bpy.data.objects['ClinicPivot']
for f in frames:
    u = min(1.0, (f-1)/(sc.frame_end-1))
    p = 1-(1-u)**2
    piv.rotation_euler = (0, 0, math.radians(-180*(1-p)))
    sc.frame_set(f)
    sc.render.filepath = os.path.join(outdir, 'f%03d.png' % f)
    bpy.ops.render.render(write_still=True)
    print('DONE', f)
