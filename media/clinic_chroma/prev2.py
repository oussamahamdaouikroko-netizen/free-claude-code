import bpy, sys, os
bpy.ops.wm.open_mainfile(filepath="/tmp/clinic.blend")
argv=sys.argv[sys.argv.index('--')+1:]
outdir,pct,samples=argv[0],int(argv[1]),int(argv[2])
frames=[int(x) for x in argv[3].split(',')]
os.makedirs(outdir,exist_ok=True)
sc=bpy.context.scene
sc.render.resolution_percentage=pct; sc.cycles.samples=samples
sc.render.image_settings.color_depth='8'
for f in frames:
    sc.frame_set(f); sc.render.filepath=os.path.join(outdir,'f%03d.png'%f)
    bpy.ops.render.render(write_still=True); print('DONE',f)
