import bpy, os
bpy.ops.wm.open_mainfile(filepath="/tmp/clinic.blend")
sc = bpy.context.scene
sc.render.resolution_percentage = 100
sc.cycles.samples = 36
sc.render.filepath = "/home/user/free-claude-code/media/clinic_chroma/frames/f"
sc.render.image_settings.color_depth = '16'
sc.render.image_settings.color_mode = 'RGBA'
sc.render.use_overwrite = False
sc.render.use_placeholder = True
bpy.ops.render.render(animation=True)
print("RENDER_COMPLETE")
